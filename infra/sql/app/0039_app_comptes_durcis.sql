-- WAKATNET — migration 0039 : comptes, inscription et vérification de l'adresse durcis (audit du 13/11/2026).
-- Ticket : docs/REVUE_SECURITE.md (F9, M4) ; docs/adr/0019-fournisseur-email.md (section « Audit du 13/11/2026 »).
--
--   1. [Élevé] Adresses du domaine wakatnet.invalid : seule la ligne purgée elle-même peut porter purge-<son id>. Un tiers
--      ne réserve plus d'avance l'adresse d'une purge à venir (l'erreur d'unicité faisait échouer TOUTE inscription). La
--      purge est isolée (sous-transaction) : son échec ne fait jamais échouer l'inscription.
--   2. [Moyen] Une création de compte en échec (nom trop long…) répond comme une adresse prise, et l'essai reste compté
--      dans le budget de la source (il l'est avant la création, et n'est plus annulé par l'erreur).
--   3. [Moyen] Pré-appropriation : une inscription qui vise une adresse EXISTANTE NON CONFIRMÉE remplace le mot de passe
--      et invalide les liens ouverts. Statut 'attente' : l'API répond pareil (F9) et envoie un avis sans lien.
--   4. [Moyen] Plafond global d'e-mails réservé AVANT de créer le lien, dans la même transaction : un lien qui ne part pas
--      n'est ni créé ni compté dans la limite à vie ; un envoi refusé par le fournisseur est décompté
--      (verification_annuler). Plafond quotidien par source : 10 demandes par 24 h, inscriptions et renvois confondus.
-- Ni enroll_register ni admin_acces ne sont touchés ici (migration 0036).

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- 1. Domaine réservé. La contrainte est posée NOT VALID, les lignes qui la violent (adresses réservées d'avance par un
--    tiers : elles ne reçoivent aucun e-mail, leur compte n'a jamais pu être confirmé par lien) sont neutralisées comme
--    une purge, puis la contrainte est validée. Les lignes déjà purgées (purge-<leur id>) la respectent.
-- ---------------------------------------------------------------------------
ALTER TABLE app.utilisateur ADD CONSTRAINT utilisateur_email_reservee
  CHECK (email !~ '@([^@]*\.)?wakatnet\.invalid$' OR email = 'purge-' || id || '@wakatnet.invalid') NOT VALID;

INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
SELECT u.tenant_id, 'migration:0039', 'adresse_reservee_neutralisee', 'utilisateur:' || u.id
  FROM app.utilisateur u
 WHERE u.email ~ '@([^@]*\.)?wakatnet\.invalid$' AND u.email <> 'purge-' || u.id || '@wakatnet.invalid';
-- En deux temps : l'adresse finale purge-<id> d'une ligne peut être tenue par une autre ligne neutralisée ici. L'adresse
-- d'attente (domaine reserve-0039.invalid, hors du domaine réservé) porte un tirage au hasard : nul ne la tient d'avance.
UPDATE app.utilisateur u SET email = 'r' || u.id || '-' || md5(random()::text) || '@reserve-0039.invalid', actif = false
 WHERE u.email ~ '@([^@]*\.)?wakatnet\.invalid$' AND u.email <> 'purge-' || u.id || '@wakatnet.invalid';
UPDATE app.utilisateur u SET email = 'purge-' || u.id || '@wakatnet.invalid'
 WHERE u.email ~ '^r[0-9]+-[0-9a-f]{32}@reserve-0039\.invalid$';
ALTER TABLE app.utilisateur VALIDATE CONSTRAINT utilisateur_email_reservee;

-- ---------------------------------------------------------------------------
-- 4. Budget par source : 5 demandes par heure et par nature (inchangé), et 10 par 24 h, natures confondues (chaque
--    demande peut faire partir un e-mail). Verrou par source, pour les deux natures.
--    La source est un HMAC renouvelé chaque jour UTC (cle-ip.ts) : la fenêtre de 24 h repart au changement de jour.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app._source_admise(p_nature text, p_source text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path = app, pg_temp
AS $$
DECLARE
  v_source text := left(coalesce(nullif(p_source, ''), '?'), 64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_source:' || v_source));
  IF (SELECT count(*) FROM app.source_demande d WHERE d.nature = p_nature AND d.source = v_source
        AND d.le > now() - interval '1 hour') >= 5
     OR (SELECT count(*) FROM app.source_demande d WHERE d.nature IN ('inscription', 'renvoi') AND d.source = v_source
        AND d.le > now() - interval '24 hours') >= 10 THEN
    RETURN false;
  END IF;
  INSERT INTO app.source_demande (nature, source) VALUES (p_nature, v_source);
  DELETE FROM app.source_demande WHERE le < now() - interval '1 day';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app._source_admise(text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Inscription : 'cree' (compte neuf : lien), 'existe' (adresse confirmée, ou création en échec : avis s'il y a un
-- utilisateur), 'attente' (adresse inscrite NON confirmée : mot de passe remplacé, liens ouverts invalidés ; avis sans
-- lien), 'trop' (budget de la source épuisé). L'API répond pareil pour 'cree', 'existe' et 'attente' (F9).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.inscription_demander(p_nom_proprietaire text, p_email text, p_mot_de_passe text, p_source text)
RETURNS TABLE (statut text, utilisateur_id bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(left(p_email, 254));
  v app.utilisateur%ROWTYPE;
  r record;
BEGIN
  -- Compté AVANT la création : une création en échec ne l'annule plus (elle est rattrapée plus bas).
  IF NOT app._source_admise('inscription', p_source) THEN
    RETURN QUERY SELECT 'trop'::text, NULL::bigint; RETURN;
  END IF;
  -- Adresse libérée : un propriétaire jamais confirmé au bout de 7 jours perd l'adresse (purge-<son id>, que lui seul
  -- peut porter : contrainte utilisateur_email_reservee) ; son compte est désactivé. 100 au plus par appel. Isolée :
  -- une erreur ici n'annule que la purge, jamais l'inscription ; seul son code est signalé (aucune donnée).
  BEGIN
    UPDATE app.utilisateur u SET email = 'purge-' || u.id || '@wakatnet.invalid', actif = false
     WHERE u.id IN (SELECT x.id FROM app.utilisateur x WHERE x.role = 'proprietaire' AND x.email_verifie_le IS NULL
                       AND x.cree_le < now() - interval '7 days' AND x.email NOT LIKE '%@wakatnet.invalid' LIMIT 100);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'inscription_demander : purge des adresses non confirmées en échec (%)', SQLSTATE;
  END;
  SELECT * INTO v FROM app.utilisateur u WHERE u.email = v_email;
  IF FOUND THEN
    IF v.role = 'proprietaire' AND v.actif AND v.email_verifie_le IS NULL THEN
      -- Pré-appropriation (audit du 13/11/2026) : la dernière demande fixe le mot de passe ; les liens ouverts avant elle
      -- ne valent plus (ils restent comptés dans les limites de liens). Même verrou que verification_creer.
      PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || v.id));
      UPDATE app.utilisateur SET mot_de_passe = p_mot_de_passe WHERE id = v.id AND email_verifie_le IS NULL;
      IF FOUND THEN
        UPDATE app.verification_email e SET expire_le = now()
         WHERE e.utilisateur_id = v.id AND e.consomme_le IS NULL AND e.expire_le > now();
        INSERT INTO app.audit_log (tenant_id, acteur, action, objet)
        VALUES (v.tenant_id, 'inscription', 'mot_de_passe_remplace_avant_confirmation', 'utilisateur:' || v.id);
        RETURN QUERY SELECT 'attente'::text, v.id; RETURN;
      END IF;
    END IF;
    RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
  END IF;
  BEGIN
    SELECT * INTO r FROM app.inscription(p_nom_proprietaire, p_email, p_mot_de_passe);
  EXCEPTION
    WHEN unique_violation THEN                               -- course entre deux inscriptions identiques
      SELECT u.id INTO v.id FROM app.utilisateur u WHERE u.email = v_email;
      RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
    WHEN OTHERS THEN                                         -- toute autre erreur : même réponse, rien n'est créé
      RETURN QUERY SELECT 'existe'::text, NULL::bigint; RETURN;
  END;
  IF r.statut <> 'cree' THEN
    SELECT u.id INTO v.id FROM app.utilisateur u WHERE u.email = v_email;
    RETURN QUERY SELECT 'existe'::text, v.id; RETURN;
  END IF;
  RETURN QUERY SELECT 'cree'::text, r.utilisateur_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Nouveau lien : la place sur le plafond global (courriel_reserver) est prise AVANT de créer et de compter le lien,
-- dans la même transaction. Plafond plein : rien n'est créé ni compté. Verrous : utilisateur, puis plafond global.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.verification_creer(p_utilisateur bigint, p_empreinte bytea)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || p_utilisateur));
  SELECT u.email INTO v_email FROM app.utilisateur u
   WHERE u.id = p_utilisateur AND u.role = 'proprietaire' AND u.actif AND u.email_verifie_le IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM app.verification_email v WHERE v.utilisateur_id = p_utilisateur
        AND v.cree_le > now() - interval '1 hour') >= 3
     OR (SELECT count(*) FROM app.utilisateur_liens n WHERE n.utilisateur_id = p_utilisateur) >= 5 THEN
    RETURN NULL;
  END IF;
  IF NOT app.courriel_reserver() THEN RETURN NULL; END IF;
  INSERT INTO app.verification_email (utilisateur_id, empreinte, expire_le) VALUES (p_utilisateur, p_empreinte, now() + interval '24 hours');
  INSERT INTO app.utilisateur_liens (utilisateur_id) VALUES (p_utilisateur);
  DELETE FROM app.verification_email WHERE cree_le < now() - interval '7 days';
  RETURN v_email;
END;
$$;

-- Envoi refusé par le fournisseur : le lien n'est pas parti, il ne compte pas (ni dans les 3 par heure, ni dans les 5 en
-- tout). La place prise sur le plafond global reste (le fournisseur a pu l'envoyer malgré l'erreur). L'API seule connaît
-- l'empreinte d'un lien qu'elle vient de créer.
CREATE FUNCTION app.verification_annuler(p_empreinte bytea)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_u bigint;
BEGIN
  SELECT e.utilisateur_id INTO v_u FROM app.verification_email e WHERE e.empreinte = p_empreinte AND e.consomme_le IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || v_u));
  DELETE FROM app.verification_email e WHERE e.empreinte = p_empreinte AND e.consomme_le IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM app.utilisateur_liens WHERE id = (SELECT max(n.id) FROM app.utilisateur_liens n WHERE n.utilisateur_id = v_u);
  RETURN true;
END;
$$;

-- Avis « compte existant » ou « compte en attente » : 1 par jour et par compte, compté à part des liens ; place sur le
-- plafond global prise avant de compter l'avis.
CREATE OR REPLACE FUNCTION app.avis_compte_existant(p_utilisateur bigint)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wakatnet_verification:' || p_utilisateur));
  SELECT u.email INTO v_email FROM app.utilisateur u WHERE u.id = p_utilisateur AND u.actif;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM app.avis_envoye a WHERE a.utilisateur_id = p_utilisateur AND a.le > now() - interval '24 hours') THEN
    RETURN NULL;
  END IF;
  IF NOT app.courriel_reserver() THEN RETURN NULL; END IF;
  INSERT INTO app.avis_envoye (utilisateur_id) VALUES (p_utilisateur);
  DELETE FROM app.avis_envoye WHERE le < now() - interval '7 days';
  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION app.inscription_demander(text, text, text, text), app.verification_creer(bigint, bytea),
  app.verification_annuler(bytea), app.avis_compte_existant(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inscription_demander(text, text, text, text), app.verification_creer(bigint, bytea),
  app.verification_annuler(bytea), app.avis_compte_existant(bigint) TO wk_api;

RESET ROLE;
