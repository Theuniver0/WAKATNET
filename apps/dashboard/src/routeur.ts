import { useEffect, useState } from "react";

/** Routeur maison sur le « # » de l'URL : « #/forfaits » -> « /forfaits ». */
export const cheminActuel = (): string => {
  const h = window.location.hash.replace(/^#/, "");
  return h === "" ? "/" : h.split("?")[0] ?? "/";
};

export function useChemin(): string {
  const [chemin, setChemin] = useState(cheminActuel());
  useEffect(() => {
    const f = () => setChemin(cheminActuel());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return chemin;
}

export const aller = (chemin: string): void => {
  window.location.hash = `#${chemin}`;
};
