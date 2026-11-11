-- WAKATNET — migration 0004 : refus codés, portée et suspension (phase 1, ticket 03).
-- Ticket : .scratch/phase-1-coeur-radius/issues/03-refus-codes.md
-- Contrats : ADR 0006 §3, §4 (causes et ordre d'évaluation), §5 (Session-Timeout) ; ADR 0007.
--
-- Remplace radius._authorize_at (même signature : propriétaire et droits conservés).
-- L'enveloppe radius.authorize (now()) ne change pas.
--
-- Ordre d'évaluation (ADR 0006 §4), pour ce ticket :
--   ticket_inconnu -> proprietaire_suspendu -> mauvais_site -> expire -> epuise
-- trop_de_tentatives (ticket 07, en tête) et trop_d_appareils (ticket 06, en fin) viendront s'y insérer.
--
-- Règles de calcul (en secondes, sur des numeric exacts à la microseconde) :
--   * instant de référence NULL ou infini -> « expire » (appel direct de la fonction interne seulement) ;
--   * reste de validité   = min(f_validity_s, activated_at + f_validity_s − maintenant) (ticket activé seulement) ;
--   * reste d'expiration  = expires_at − maintenant ;
--   * « expire » dès que l'un de ces restes, arrondi à la seconde inférieure, est < 1 :
--     une fenêtre de moins d'une seconde ne peut pas donner Session-Timeout >= 1 ;
--   * Session-Timeout = plancher(min(uptime figé, validité restante ou entière, expiration restante)),
--     plafonné à 2^31 − 1 (entier RADIUS de 32 bits : au-delà, FreeRADIUS ignorerait l'attribut
--     et l'Accept partirait sans durée) ; < 1, absent ou infini -> « epuise ».
-- Ces règles sont consignées dans l'ADR 0006 (amendement du ticket 03).
-- Les dates infinies (±infinity) sont traitées sans exception : extract(epoch) les rend en
-- ±Infinity (numeric), au lieu de l'erreur « cannot subtract infinite timestamps » de la version 0002.
-- La consommation (temps, volume) arrive au ticket 05.

SET ROLE wakatnet_owner;

CREATE OR REPLACE FUNCTION radius._authorize_at(p_user text, p_src text, p_calling text, p_called text, p_now timestamptz)
RETURNS TABLE (cleartext_password text, decision text, reply_message text,
               session_timeout bigint, rate_limit text, port_limit integer, interim integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = radius, pg_temp
AS $$
DECLARE
  v_ip               inet;
  v_routeur          app.router%ROWTYPE;
  v_ticket           app.voucher%ROWTYPE;
  v_suspendu         boolean;
  v_code             text := upper(coalesce(p_user, ''));
  v_now              numeric := extract(epoch FROM p_now);
  v_reste_validite   numeric;
  v_reste_expiration numeric;
  v_timeout          numeric;
  v_cause            text;
BEGIN
  BEGIN
    v_ip := p_src::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  -- Chaque étape pose la cause qu'elle produirait, puis sort du bloc si la condition
  -- de refus est remplie. Une condition indéterminée (NULL) ne vaut jamais acceptation.
  <<regles>>
  BEGIN
    -- Instant de référence inutilisable : seul un appel direct de la fonction interne
    -- (rôle de test) peut le produire, l'enveloppe passant now(). Jamais d'Accept sans repère.
    v_cause := 'expire';
    EXIT regles WHEN p_now IS NULL OR NOT isfinite(p_now);

    v_cause := 'ticket_inconnu';
    -- Routeur : déduit de l'IP source uniquement (§5.1) ; le propriétaire et le site en découlent.
    SELECT * INTO v_routeur FROM app.router r WHERE r.overlay_ip = v_ip AND r.actif;
    EXIT regles WHEN NOT FOUND;
    -- Ticket : clé (propriétaire, code), jamais le code seul (ADR 0006 §3, T6).
    SELECT * INTO v_ticket FROM app.voucher v WHERE v.tenant_id = v_routeur.tenant_id AND v.code = v_code;
    EXIT regles WHEN NOT FOUND;

    -- Suspension ADMINISTRATIVE seulement (ADR 0006 §4) : rien d'autre du propriétaire n'est lu.
    v_cause := 'proprietaire_suspendu';
    SELECT t.suspendu INTO v_suspendu FROM app.tenant t WHERE t.id = v_routeur.tenant_id;
    EXIT regles WHEN v_suspendu IS NOT FALSE;

    -- Portée figée sur le ticket : tout le propriétaire, ou un site précis.
    v_cause := 'mauvais_site';
    EXIT regles WHEN NOT coalesce(
      v_ticket.f_scope = 'tenant'
      OR (v_ticket.f_scope = 'site' AND v_ticket.f_site_id = v_routeur.site_id), false);

    v_cause := 'expire';
    IF v_ticket.f_validity_s IS NOT NULL AND v_ticket.activated_at IS NOT NULL THEN
      -- Borné par la validité du forfait : une activation datée dans le futur (horloge du
      -- nœud reculée, donnée corrompue) ne donne jamais plus que ce qui a été vendu.
      v_reste_validite := least(v_ticket.f_validity_s::numeric,
                                extract(epoch FROM v_ticket.activated_at) + v_ticket.f_validity_s - v_now);
      EXIT regles WHEN floor(v_reste_validite) < 1;
    END IF;
    IF v_ticket.expires_at IS NOT NULL THEN
      v_reste_expiration := extract(epoch FROM v_ticket.expires_at) - v_now;
      EXIT regles WHEN floor(v_reste_expiration) < 1;
    END IF;

    -- least() ignore les NULL : seules les dimensions présentes comptent.
    v_cause := 'epuise';
    v_timeout := least(
      v_ticket.f_uptime_limit_s::numeric,
      CASE WHEN v_ticket.activated_at IS NULL THEN v_ticket.f_validity_s::numeric ELSE v_reste_validite END,
      v_reste_expiration);
    EXIT regles WHEN v_timeout IS NULL OR v_timeout = 'Infinity'::numeric OR floor(v_timeout) < 1;

    v_cause := NULL;
  END;

  IF v_cause IS NOT NULL THEN
    -- Un refus ne porte jamais d'attribut d'Accept (ADR 0006 §2).
    RETURN QUERY SELECT NULL::text, 'Reject'::text, v_cause,
                        NULL::bigint, NULL::text, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_ticket.code,
    'Accept'::text,
    NULL::text,
    least(floor(v_timeout), 2147483647)::bigint,
    v_ticket.f_rate_limit,
    v_ticket.f_devices,
    -- CHECK de radius.parametre : la conversion ne peut pas échouer.
    coalesce((SELECT p.valeur::integer FROM radius.parametre p WHERE p.cle = 'acct_interim_interval_s'), 120);
END;
$$;

RESET ROLE;
