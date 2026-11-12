import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { messageDe } from "./api.ts";

/** Écran : un seul h1, qui reçoit le focus à l'arrivée (lecteurs d'écran). */
export function Ecran({ titre, children }: { titre: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
    document.title = `${titre} - WAKATNET`;
  }, [titre]);
  return (
    <>
      <h1 ref={ref} tabIndex={-1}>{titre}</h1>
      {children}
    </>
  );
}

export function Alerte({ message }: { message: string | null }) {
  return message ? <p role="alert" className="alerte">{message}</p> : null;
}

export function Info({ message }: { message: string | null }) {
  return <div role="status" className="info">{message}</div>;
}

type ChampProps = {
  libelle: string; valeur: string; onChange: (v: string) => void; type?: string; requis?: boolean;
  min?: number; max?: number; autoComplete?: string; aide?: string; inputMode?: "numeric" | "text";
};

export function Champ({ libelle, valeur, onChange, type = "text", requis = false, min, max, autoComplete, aide, inputMode }: ChampProps) {
  const id = useId();
  return (
    <div className="champ">
      <label htmlFor={id}>{libelle}</label>
      <input id={id} type={type} value={valeur} required={requis} min={min} max={max} autoComplete={autoComplete} inputMode={inputMode}
        aria-describedby={aide ? `${id}-aide` : undefined} onChange={(e) => onChange(e.target.value)} />
      {aide ? <span id={`${id}-aide`} className="aide">{aide}</span> : null}
    </div>
  );
}

export function Choix({ libelle, valeur, onChange, options, requis = false }: {
  libelle: string; valeur: string; onChange: (v: string) => void; options: { valeur: string; texte: string }[]; requis?: boolean;
}) {
  const id = useId();
  return (
    <div className="champ">
      <label htmlFor={id}>{libelle}</label>
      <select id={id} value={valeur} required={requis} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choisir…</option>
        {options.map((o) => <option key={o.valeur} value={o.valeur}>{o.texte}</option>)}
      </select>
    </div>
  );
}

/** Charge une ressource ; garde l'erreur lisible et permet de recharger. */
export function useCharge<T>(charger: () => Promise<T>, actif = true): { donnees: T | null; erreur: string | null; recharger: () => void } {
  const [donnees, setDonnees] = useState<T | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const f = useRef(charger);
  f.current = charger;
  useEffect(() => {
    if (!actif) return;
    let vivant = true;
    f.current().then((d) => { if (vivant) { setDonnees(d); setErreur(null); } },
                     (e: unknown) => { if (vivant) setErreur(messageDe(e)); });
    return () => { vivant = false; };
  }, [n, actif]);
  const recharger = useCallback(() => setN((x) => x + 1), []);
  return { donnees, erreur, recharger };
}

/** Exécute une action avec message de succès ou d'erreur. */
export function useAction() {
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const [occupe, setOccupe] = useState(false);
  const lancer = useCallback(async (f: () => Promise<string | void>) => {
    setErreur(null);
    setInfo("");
    setOccupe(true);
    try {
      const m = await f();
      if (typeof m === "string") setInfo(m);
    } catch (e) {
      setErreur(messageDe(e));
    } finally {
      setOccupe(false);
    }
  }, []);
  return { erreur, info, occupe, lancer, setErreur };
}
