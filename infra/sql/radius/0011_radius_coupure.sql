-- WAKATNET — migration 0011 : sessions à couper, cible d'un Disconnect / CoA (phase 1, ticket 09).
-- Ticket : .scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md
-- Contrats : ADR 0006 §1 (sessions_to_cut, mark_cut, coa_target ; rôle wk_coa), §6, §17 ;
-- ADR 0010 (émetteur et déclencheur).

-- Rôle du déclencheur de coupure (ADR 0006 §1, §17) : SEUL rôle qui lit le secret d'un routeur
-- à partir d'une session. Mot de passe posé par migrer.sh (WAKATNET_PG_COA_PASSWORD).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_coa') THEN
    CREATE ROLE wk_coa LOGIN;
  END IF;
END $$;

SET ROLE wakatnet_owner;

-- Suivi des envois (ADR 0010 §3). Une tentative = un tour du déclencheur sur la session.
ALTER TABLE radius.session
  ADD COLUMN coupure_tentatives integer NOT NULL DEFAULT 0 CHECK (coupure_tentatives >= 0),
  ADD COLUMN coupure_resultat   text CHECK (coupure_resultat IN ('ack', 'nak', 'sans_reponse', 'abandon')),
  ADD COLUMN coupure_le         timestamptz;

INSERT INTO radius.parametre (cle, valeur) VALUES
  ('coupure_tentatives_max', '5');   -- tours sans réponse avant abandon (et alerte)

-- Alertes de coupure (revue du ticket 09) : abandon après N tours muets, et NAK (le routeur
-- refuse : session inconnue, attribut refusé… ; la session peut continuer de consommer).
ALTER TABLE radius.alerte DROP CONSTRAINT alerte_type_check;
ALTER TABLE radius.alerte ADD CONSTRAINT alerte_type_check
  CHECK (type IN ('blocage_mac', 'echecs_routeur', 'coupure_abandonnee', 'coupure_refusee'));
ALTER TABLE radius.alerte ADD COLUMN session_id bigint;

-- Sessions à couper, au plus p_limite par tour. Ordre (revue du ticket 09) : d'abord celles
-- jamais tentées, puis la tentative la plus ancienne ; une session muette passe donc derrière
-- les autres et ne les affame pas tour après tour :
--   - inscrites « à couper » par l'accounting (volume ou temps épuisé, tickets 05 et 06) ;
--   - ou dont le propriétaire est suspendu (ADR 0006 §6).
-- La session doit être vivante (ouverte, ou fermée d'office mais encore active : _vivante).
-- Exclues : déjà acquittées (ack), refusées par le routeur (nak : session inconnue de lui),
-- abandonnées. Le remboursement (ADR 0006 §6) n'existe pas avant la phase 3.
CREATE FUNCTION radius.sessions_to_cut(p_limite integer DEFAULT 100)
RETURNS TABLE (session_id bigint, motif text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
  SELECT s.id, coalesce(s.motif_coupure, 'proprietaire_suspendu')
    FROM radius.session s
    JOIN app.tenant t ON t.id = s.tenant_id
   WHERE (s.a_couper_le IS NOT NULL OR t.suspendu)
     AND s.coupure_resultat IS DISTINCT FROM 'ack'
     AND s.coupure_resultat IS DISTINCT FROM 'nak'
     AND s.coupure_resultat IS DISTINCT FROM 'abandon'
     AND radius._vivante(s.arrete_le, s.cause_fin, s.dernier_evenement_le, s.interim_s, now())
   ORDER BY s.coupure_le NULLS FIRST, coalesce(s.a_couper_le, s.dernier_evenement_le), s.id
   LIMIT greatest(least(p_limite, 1000), 1);
$$;

-- Cible d'un Disconnect ou d'un CoA : la SEULE fonction qui rend le secret d'un routeur à
-- partir d'une session (ADR 0006 §1, §14). Session inconnue : aucune ligne. nas_ip en texte
-- (et non inet, ADR 0006 §1) : c'est ce que lit le déclencheur ; écart déclaré (ADR 0010 §3).
-- Routeur désactivé : la cible est rendue quand même (couper reste souhaitable).
CREATE FUNCTION radius.coa_target(p_session bigint)
RETURNS TABLE (nas_ip text, coa_port integer, secret text, acct_session_id text, username text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
  SELECT host(r.overlay_ip), r.coa_port, rs.secret, s.acct_session_id, v.code
    FROM radius.session s
    JOIN app.router r ON r.id = s.router_id
    JOIN radius.router_secret rs ON rs.router_id = r.id
    JOIN app.voucher v ON v.id = s.voucher_id
   WHERE s.id = p_session
   LIMIT 1;
$$;

-- Résultat d'un tour : 'ack', 'nak' ou 'sans_reponse'. Au-delà de coupure_tentatives_max tours
-- sans réponse : 'abandon' et une alerte. Un 'nak' donne aussi une alerte. Rend le résultat
-- enregistré. Session déjà dans un état final (ack, nak, abandon) : rien ne change, et l'état
-- final est rendu (tour tué entre l'envoi et l'enregistrement, appel concurrent).
-- Résultat inconnu ou session inconnue : exception (erreur de programmation du déclencheur).
CREATE FUNCTION radius.mark_cut(p_session bigint, p_result text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_max integer := radius._param_entier('coupure_tentatives_max', 5);
  v_resultat text;
  v_router bigint;
  v_tenant bigint;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('ack', 'nak', 'sans_reponse') THEN
    RAISE EXCEPTION 'mark_cut : résultat invalide (%)', p_result;
  END IF;
  SELECT s.coupure_resultat INTO v_resultat FROM radius.session s WHERE s.id = p_session FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_cut : session inconnue (%)', p_session;
  END IF;
  IF v_resultat IN ('ack', 'nak', 'abandon') THEN
    RETURN v_resultat;
  END IF;
  UPDATE radius.session s
     SET coupure_tentatives = s.coupure_tentatives + 1,
         coupure_le = now(),
         coupure_resultat = CASE
           WHEN p_result = 'sans_reponse' AND s.coupure_tentatives + 1 >= v_max THEN 'abandon'
           ELSE p_result END
   WHERE s.id = p_session
  RETURNING s.coupure_resultat, s.router_id, s.tenant_id INTO v_resultat, v_router, v_tenant;
  IF v_resultat IN ('abandon', 'nak') THEN
    INSERT INTO radius.alerte (type, router_id, tenant_id, session_id)
    VALUES (CASE v_resultat WHEN 'abandon' THEN 'coupure_abandonnee' ELSE 'coupure_refusee' END,
            v_router, v_tenant, p_session);
  END IF;
  RETURN v_resultat;
END;
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION radius.sessions_to_cut(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.coa_target(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION radius.mark_cut(bigint, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA radius TO wk_coa;
GRANT EXECUTE ON FUNCTION radius.sessions_to_cut(integer) TO wk_coa;
GRANT EXECUTE ON FUNCTION radius.coa_target(bigint) TO wk_coa;
GRANT EXECUTE ON FUNCTION radius.mark_cut(bigint, text) TO wk_coa;
-- Hors chemin critique ; coa_target rend un secret : l'instruction n'est jamais journalisée.
ALTER ROLE wk_coa SET statement_timeout = '5s';
ALTER ROLE wk_coa SET log_min_error_statement = 'panic';
ALTER ROLE wk_coa SET log_min_duration_statement = -1;
ALTER ROLE wk_coa SET log_statement = 'none';
