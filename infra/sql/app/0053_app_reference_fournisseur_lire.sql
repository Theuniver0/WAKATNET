-- WAKATNET — migration 0053 : lecture de la référence du fournisseur d'un paiement, pour verify() (ADR 0024, MoneyFusion).
-- MoneyFusion ne se consulte que par SON jeton (GET /paiementNotif/{token}) : le service doit le relire avant chaque
-- rapprochement. La colonne reference_fournisseur n'est pas lisible par wk_api (0019) et ne le devient pas : seule cette
-- fonction la rend, pour UN paiement d'UN propriétaire (même garde que paiement_du_proprietaire).
SET ROLE wakatnet_owner;

CREATE FUNCTION app.paiement_reference_fournisseur_lire(p_reference text, p_tenant bigint)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp
AS $$ SELECT p.reference_fournisseur FROM app.payment p WHERE p.reference = p_reference AND p.tenant_id = p_tenant $$;

REVOKE ALL ON FUNCTION app.paiement_reference_fournisseur_lire(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.paiement_reference_fournisseur_lire(text, bigint) TO wk_api;

RESET ROLE;
