-- WAKATNET — migration 0025 : mode B verrouillé, reversements (phase 4, ticket 07).
-- Ticket : .scratch/phase-4-exploitation/issues/07-mode-b-p10.md
-- Contrats : ADR 0014 §8, §9 ; ADR 0001 ; SPEC §7.4 (P10), §8.3.

SET ROLE wakatnet_owner;

-- ---------------------------------------------------------------------------
-- Drapeaux de plateforme : AUCUN droit pour les rôles de connexion. `mode_b_autorise` ne se pose
-- qu'à la main, par l'administrateur de la base, après l'accord écrit consigné dans
-- docs/CONFORMITE.md (ADR 0001).
-- ---------------------------------------------------------------------------
CREATE TABLE app.plateforme_parametre (
  cle     text PRIMARY KEY CHECK (cle ~ '^[a-z_]{1,64}$'),
  valeur  boolean NOT NULL,
  note    text NOT NULL DEFAULT '',
  maj_le  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.plateforme_parametre (cle, valeur, note)
VALUES ('mode_b_autorise', false, 'ADR 0001 : verrouillé tant que docs/CONFORMITE.md ne contient pas l''accord écrit et l''avis juridique');

CREATE FUNCTION app._mode_b_verrou()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.settlement_mode = 'B' AND NOT coalesce((SELECT valeur FROM app.plateforme_parametre WHERE cle = 'mode_b_autorise'), false) THEN
    RAISE EXCEPTION 'mode B verrouillé (ADR 0001) : accord écrit et avis juridique requis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mode_b_verrou BEFORE INSERT OR UPDATE OF settlement_mode ON app.tenant
  FOR EACH ROW EXECUTE FUNCTION app._mode_b_verrou();

-- ---------------------------------------------------------------------------
-- Reversements (mode B) : écriture AVANT l'envoi (EN_DOUTE), puis verdict. Un reversement en doute
-- n'est JAMAIS renvoyé sans verifyPayout() (P10, ADR 0014 §9).
-- ---------------------------------------------------------------------------
CREATE TABLE app.payout (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id              bigint NOT NULL REFERENCES app.tenant (id),
  reference              text   NOT NULL UNIQUE CHECK (reference ~ '^po_[A-Za-z0-9_-]{8,64}$'),
  montant                bigint NOT NULL CHECK (montant > 0),
  statut                 text   NOT NULL DEFAULT 'CREATED' CHECK (statut IN ('CREATED', 'EN_DOUTE', 'SENT', 'SUCCEEDED', 'FAILED')),
  reference_fournisseur  text   CHECK (length(reference_fournisseur) <= 128),
  envois                 integer NOT NULL DEFAULT 0 CHECK (envois >= 0),
  cree_le                timestamptz NOT NULL DEFAULT now(),
  maj_le                 timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.payout ENABLE ROW LEVEL SECURITY;

-- Le drapeau est relu à la création ET au traitement : le rabaisser gèle aussi les reversements.
CREATE FUNCTION app._mode_b_autorise()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ SELECT coalesce((SELECT valeur FROM app.plateforme_parametre WHERE cle = 'mode_b_autorise'), false) $$;

-- Création : seulement pour un propriétaire en mode B, drapeau levé.
CREATE FUNCTION app.reversement_creer(p_tenant bigint, p_montant bigint, p_reference text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT app._mode_b_autorise() OR NOT EXISTS (SELECT 1 FROM app.tenant WHERE id = p_tenant AND settlement_mode = 'B') THEN
    RAISE EXCEPTION 'reversement réservé au mode B' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.payout (tenant_id, reference, montant) VALUES (p_tenant, p_reference, p_montant)
  ON CONFLICT (reference) DO NOTHING;
  RETURN (SELECT statut FROM app.payout WHERE reference = p_reference);
END;
$$;

-- Avant l'envoi : CREATED → EN_DOUTE (écrit et validé AVANT l'appel au fournisseur). Rend true si
-- l'appelant peut envoyer maintenant.
CREATE FUNCTION app.reversement_avant_envoi(p_reference text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  UPDATE app.payout SET statut = 'EN_DOUTE', envois = envois + 1, maj_le = now()
   WHERE reference = p_reference AND statut = 'CREATED';
  RETURN FOUND;
END;
$$;

-- Après un verifyPayout() qui répond « inconnu » : le fournisseur n'a jamais reçu l'ordre ; seul
-- cas où un reversement en doute peut repartir (EN_DOUTE → EN_DOUTE, envoi compté).
-- Comparaison-échange sur `envois` : deux traitements concurrents ne peuvent pas renvoyer tous deux.
-- Au plus 5 envois : au-delà, le reversement reste EN_DOUTE pour une décision humaine.
CREATE FUNCTION app.reversement_renvoi_permis(p_reference text, p_envois_vus integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  UPDATE app.payout SET envois = envois + 1, maj_le = now()
   WHERE reference = p_reference AND statut = 'EN_DOUTE' AND envois = p_envois_vus AND envois < 5;
  RETURN FOUND;
END;
$$;

-- Verdict : depuis EN_DOUTE ou SENT seulement ; SUCCEEDED et FAILED sont finaux.
CREATE FUNCTION app.reversement_verdict(p_reference text, p_statut text, p_reference_fournisseur text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
  IF p_statut NOT IN ('SENT', 'SUCCEEDED', 'FAILED') THEN RAISE EXCEPTION 'verdict invalide %', p_statut; END IF;
  UPDATE app.payout SET statut = p_statut, maj_le = now(),
         reference_fournisseur = coalesce(left(p_reference_fournisseur, 128), reference_fournisseur)
   WHERE reference = p_reference AND statut IN ('EN_DOUTE', 'SENT')
     AND NOT (statut = 'SENT' AND p_statut = 'SENT');
  RETURN (SELECT statut FROM app.payout WHERE reference = p_reference);
END;
$$;

-- Un reversement EN_DOUTE ou SENT n'est repris qu'après `p_age_min_s` secondes sans changement, et
-- JAMAIS moins de 120 s (plancher posé ici, pas par l'appelant) : bien plus que le délai d'un envoi
-- (15 s, requête annulée à l'expiration), pour ne pas vérifier un ordre encore en route.
CREATE FUNCTION app.reversements_a_traiter(p_limite integer DEFAULT 100, p_age_min_s integer DEFAULT 120)
RETURNS TABLE (reference text, tenant_id bigint, montant bigint, statut text, envois integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT p.reference, p.tenant_id, p.montant, p.statut, p.envois FROM app.payout p
   WHERE app._mode_b_autorise()
     AND (p.statut = 'CREATED'
          OR (p.statut IN ('EN_DOUTE', 'SENT') AND p.maj_le <= now() - make_interval(secs => greatest(p_age_min_s, 120))))
   ORDER BY p.id LIMIT greatest(1, least(p_limite, 1000))
$$;

REVOKE ALL ON FUNCTION app._mode_b_verrou(), app._mode_b_autorise(), app.reversement_creer(bigint, bigint, text), app.reversement_avant_envoi(text),
  app.reversement_renvoi_permis(text, integer), app.reversement_verdict(text, text, text), app.reversements_a_traiter(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reversement_creer(bigint, bigint, text), app.reversement_avant_envoi(text),
  app.reversement_renvoi_permis(text, integer), app.reversement_verdict(text, text, text), app.reversements_a_traiter(integer, integer) TO wk_api;

RESET ROLE;
