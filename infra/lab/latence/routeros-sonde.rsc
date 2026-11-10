# routeros-sonde.rsc — sonde SECONDAIRE de latence WAKATNET, sur le routeur MikroTik lui-même.
#
# Rôle : recouper la sonde principale (irtt sur le Linux derrière le routeur) et
# relever ce que la sonde Linux ne voit pas. RouterOS ne sait pas faire d'irtt :
#   (A) /tool netwatch de type icmp : perte ET RTT ICMP, relevé chaque minute ;
#   (B) un /ping planifié chaque minute : PERTE seulement (nombre de réponses),
#       indépendant des champs de netwatch ;
#   (W) compteurs d'octets de l'interface WAN chaque minute : charge du lien,
#       pour distinguer congestion de l'opérateur et charge des clients ;
#   (D) un repère de démarrage, journalisé une fois l'heure NTP retrouvée.
# Le journal part en syslog UDP vers la sonde Linux (recepteur-syslog.py), qui
# l'horodate avec son horloge NTP : rien d'important n'est écrit en flash.
# Section facultative (C) : tunnel WireGuard de labo terminé sur le routeur
# (variante R), sur une plage à part (10.254.214.0/24) : L et R tournent en même temps.
# Section facultative (H) : contournement du hotspot pour la sonde Linux.
#
# STATUT : NON EXÉCUTÉ. Aucun CHR n'a pu tourner dans la session qui a écrit ce
# fichier (pas de KVM). Règle 6 du §13 : à exécuter sur CHR (routeur vierge ET
# routeur déjà configuré) AVANT tout routeur réel. Tout ce fichier est
# « (syntaxe à confirmer sur CHR) » ; les lignes les plus douteuses le redisent.
#
# Conventions : chaque objet créé porte comment="wakatnet-labo..." (ou un nom
# wakatnet-labo-... / wklabo... quand le champ comment n'est pas sûr) ; aucune
# suppression ni réordonnancement d'objet existant ; idiome [find] ; aucun
# secret (une clé PUBLIQUE WireGuard n'en est pas un ; la clé privée du tunnel
# de labo est générée par le routeur et n'en sort pas).
#
# À remplacer avant import (marqueurs explicites, pas de valeur réelle ici) :
#   IP_PUBLIQUE_VM_FSN, IP_PUBLIQUE_VM_NBG, IP_PUBLIQUE_VM_HEL, IP_PUBLIQUE_VM_B
#     (deux endroits : paramètres et script wakatnet-labo-ping)
#   IP_LAN_SONDE        adresse LAN de la sonde Linux (syslog)
#   NOM_INTERFACE_WAN   interface WAN (ether1, lte1, pppoe-out1...) : deux endroits
#   MAC_SONDE           seulement si la sonde est derrière un hotspot (section H)
#   CLE_PUBLIQUE_VM_*   seulement pour la section C
# Supprimer les lignes des cibles inutilisées.
#
# Import : /import file-name=routeros-sonde.rsc
# Retrait : voir la section « RETRAIT » en fin de fichier.
#
# Le tout est dans un bloc { } pour que les :local restent visibles d'une ligne
# à l'autre pendant l'import (syntaxe à confirmer sur CHR).

{
# ---------------------------------------------------------------------------
# 0. Paramètres
# ---------------------------------------------------------------------------
# Cibles hors tunnel : nom court -> adresse IP publique de la VM.
:local cibles {"fsn"="IP_PUBLIQUE_VM_FSN"; "nbg"="IP_PUBLIQUE_VM_NBG"; "hel"="IP_PUBLIQUE_VM_HEL"; "b"="IP_PUBLIQUE_VM_B"}
# Sonde Linux : destinataire du journal (recepteur-syslog.py écoute sur 5514).
:local ipSyslog "IP_LAN_SONDE"
# Section H (hotspot) : MAC de la sonde Linux ; laisser "" s'il n'y a pas de hotspot.
:local macSonde ""
# Section C (tunnel de labo sur le routeur, variante R) : false par défaut.
:local avecTunnel false
# Adresse de CE routeur dans le tunnel R : une par routeur (.21, .22, .23).
:local adresseTunnelR "10.254.214.21/24"
# Journal de secours sur disque (2 fichiers x 5000 lignes, environ 1,5 Mo) :
# seulement s'il reste au moins ce nombre d'octets libres.
:local libreMin 4194304

# ---------------------------------------------------------------------------
# 1. Journal : syslog distant vers la sonde, disque en secours borné
# ---------------------------------------------------------------------------
# L'action est repérée par son nom : la présence d'un champ comment sur
# /system logging action n'est pas vérifiée (syntaxe à confirmer sur CHR).
/system logging action
:if ([:len [find name="wklabo"]] = 0) do={
  add name=wklabo target=remote remote=$ipSyslog remote-port=5514
}
# Secours sur disque, seulement si la flash a de la place. Sur un hAP lite
# (16 Mo), RouterOS 7 laisse peu d'espace libre (ordre de grandeur à vérifier) :
# une flash pleine peut empêcher la sauvegarde de la configuration.
# (syntaxe à confirmer sur CHR : free-hdd-space en octets)
:if ([/system resource get free-hdd-space] >= $libreMin) do={
  :if ([:len [find name="wklabodisque"]] = 0) do={
    add name=wklabodisque target=disk disk-file-name=wakatnet-labo-latence \
        disk-lines-per-file=5000 disk-file-count=2
  }
} else={
  :put "wakatnet-labo : flash trop pleine, pas de journal disque (syslog seulement)"
}
# Le sujet « script » capte aussi les :log des autres scripts du routeur ;
# recepteur-syslog.py ne garde que les lignes qui contiennent « wakatnet-labo ».
/system logging
:if ([:len [find comment="wakatnet-labo journal latence"]] = 0) do={
  add topics=script action=wklabo comment="wakatnet-labo journal latence"
}
:if ([:len [/system logging action find name="wklabodisque"]] > 0) do={
  :if ([:len [find comment="wakatnet-labo journal latence disque"]] = 0) do={
    add topics=script action=wklabodisque comment="wakatnet-labo journal latence disque"
  }
}

# ---------------------------------------------------------------------------
# 2a. Mécanisme A : netwatch ICMP (syntaxe à confirmer sur CHR)
# ---------------------------------------------------------------------------
# Hypothèse (doc RouterOS 7, non vérifiée ici) : type=icmp accepte
# packet-count et packet-interval, et expose en lecture loss-percent,
# rtt-avg, rtt-max, rtt-jitter, status pour le dernier test.
# interval=1m : un test par minute, relevé une fois par minute (avec 30 s,
# la moitié des tests n'étaient jamais journalisés). Un relevé pendant un test
# en cours peut encore lire le test précédent : c'est sans gravité à 1 min près.
/tool netwatch
:foreach nom,ip in=$cibles do={
  :if ([:len [find comment=("wakatnet-labo netwatch " . $nom)]] = 0) do={
    add host=$ip type=icmp interval=1m packet-count=20 packet-interval=200ms \
        comment=("wakatnet-labo netwatch " . $nom)
  }
}

# Relevé chaque minute : une ligne par cible (syntaxe à confirmer sur CHR :
# noms des champs lus par « get »).
/system script
:if ([:len [find name="wakatnet-labo-netwatch"]] = 0) do={
  add name=wakatnet-labo-netwatch policy=read,write,test comment="wakatnet-labo releve netwatch" \
      source={
        :foreach i in=[/tool netwatch find where comment~"^wakatnet-labo netwatch "] do={
          :local c [/tool netwatch get $i comment]
          :local h [/tool netwatch get $i host]
          :local st [/tool netwatch get $i status]
          :local perte [/tool netwatch get $i loss-percent]
          :local moy [/tool netwatch get $i rtt-avg]
          :local mx [/tool netwatch get $i rtt-max]
          :local gig [/tool netwatch get $i rtt-jitter]
          :log info ("wakatnet-labo netwatch cible=" . [:pick $c 23 [:len $c]] . " hote=" . $h . \
                     " etat=" . $st . " perte_pct=" . $perte . " rtt_moy=" . $moy . \
                     " rtt_max=" . $mx . " gigue=" . $gig)
        }
      }
}

# ---------------------------------------------------------------------------
# 2b. Mécanisme B : /ping planifié — PERTE SEULEMENT
# ---------------------------------------------------------------------------
# Hypothèse (syntaxe à confirmer sur CHR) : en script, [/ping ...] renvoie
# le nombre de réponses reçues, sans RTT. Le RTT ICMP vient de netwatch (A).
# Variante possible, à essayer sur CHR (syntaxe à confirmer sur CHR) :
#   :foreach r in=[/ping address=$ip count=20 interval=200ms as-value] do={ ... ($r->"time") ... }
# 20 pings à 200 ms = 4 s par cible. Les cibles sont recopiées dans le script :
# remplacer les marqueurs ici aussi.
/system script
:if ([:len [find name="wakatnet-labo-ping"]] = 0) do={
  add name=wakatnet-labo-ping policy=read,write,test comment="wakatnet-labo ping planifie" \
      source={
        :local cibles {"fsn"="IP_PUBLIQUE_VM_FSN"; "nbg"="IP_PUBLIQUE_VM_NBG"; "hel"="IP_PUBLIQUE_VM_HEL"; "b"="IP_PUBLIQUE_VM_B"}
        :foreach nom,ip in=$cibles do={
          :local recus [/ping address=$ip count=20 interval=200ms]
          :log info ("wakatnet-labo ping cible=" . $nom . " hote=" . $ip . " recus=" . $recus . "/20")
        }
      }
}

# ---------------------------------------------------------------------------
# 2c. Mécanisme W : charge du lien WAN (octets cumulés, chaque minute)
# ---------------------------------------------------------------------------
# analyse.py en déduit un débit moyen par heure (différence entre deux relevés),
# à croiser avec le p95 par heure. Le nom de l'interface est recopié dans le
# script (marqueur NOM_INTERFACE_WAN). (syntaxe à confirmer sur CHR : champs
# rx-byte / tx-byte de /interface, y compris pour lte1 et pppoe-out1)
/system script
:if ([:len [find name="wakatnet-labo-wan"]] = 0) do={
  add name=wakatnet-labo-wan policy=read,write,test comment="wakatnet-labo compteurs wan" \
      source={
        :local i [/interface find name="NOM_INTERFACE_WAN"]
        :if ([:len $i] = 1) do={
          :log info ("wakatnet-labo wan iface=NOM_INTERFACE_WAN rx=" . [/interface get $i rx-byte] . \
                     " tx=" . [/interface get $i tx-byte])
        } else={
          :log warning "wakatnet-labo wan interface introuvable"
        }
      }
}

# ---------------------------------------------------------------------------
# 2d. Repère de démarrage (coupure de courant), après synchronisation NTP
# ---------------------------------------------------------------------------
# Toute la logique est dans un script (corps entre accolades, évalué à
# l'exécution, comme les autres) : le scheduler ne fait que l'appeler. Une
# expression [...] placée directement dans on-event="..." risquerait d'être
# évaluée à l'import. Le script attend que le client NTP soit synchronisé
# (au plus 5 min) : un hAP lite n'a pas d'horloge matérielle. Ce script NE
# modifie PAS /system ntp client : vérifier à la main qu'il est actif.
# (syntaxe à confirmer sur CHR : champ status de /system ntp client et sa
# valeur « synchronized » en RouterOS 7)
/system script
:if ([:len [find name="wakatnet-labo-demarrage"]] = 0) do={
  add name=wakatnet-labo-demarrage policy=read,write,test comment="wakatnet-labo repere de redemarrage" \
      source={
        :local attente 0
        :while (([/system ntp client get status] != "synchronized") && ($attente < 300)) do={
          :delay 5s
          :set attente ($attente + 5)
        }
        :log warning ("wakatnet-labo demarrage routeur uptime=" . [/system resource get uptime] . \
                      " ntp=" . [/system ntp client get status] . " attente_ntp_s=" . $attente)
      }
}

/system scheduler
:if ([:len [find name="wakatnet-labo-netwatch"]] = 0) do={
  add name=wakatnet-labo-netwatch interval=1m on-event="/system script run wakatnet-labo-netwatch" \
      policy=read,write,test comment="wakatnet-labo releve netwatch"
}
:if ([:len [find name="wakatnet-labo-ping"]] = 0) do={
  add name=wakatnet-labo-ping interval=1m on-event="/system script run wakatnet-labo-ping" \
      policy=read,write,test comment="wakatnet-labo ping planifie"
}
:if ([:len [find name="wakatnet-labo-wan"]] = 0) do={
  add name=wakatnet-labo-wan interval=1m on-event="/system script run wakatnet-labo-wan" \
      policy=read,write,test comment="wakatnet-labo compteurs wan"
}
:if ([:len [find name="wakatnet-labo-demarrage"]] = 0) do={
  add name=wakatnet-labo-demarrage start-time=startup on-event="/system script run wakatnet-labo-demarrage" \
      policy=read,write,test comment="wakatnet-labo repere de redemarrage"
}

# ---------------------------------------------------------------------------
# 3. Section H, facultative : la sonde Linux derrière un hotspot (WiFi Zone)
# ---------------------------------------------------------------------------
# Derrière /ip hotspot, la sonde serait redirigée vers le portail ou bloquée
# jusqu'à une connexion, et la mesure ne démarrerait pas (ou se couperait à
# l'expiration de la session). Deux solutions :
#   - brancher la sonde sur un port Ethernet HORS du bridge du hotspot ;
#   - ou cette exception (syntaxe à confirmer sur CHR), retirée en fin de mesure.
# Dans les deux cas, noter sur la fiche du site que la sonde contourne le hotspot.
:if ([:len $macSonde] > 0) do={
  /ip hotspot ip-binding
  :if ([:len [find comment="wakatnet-labo sonde"]] = 0) do={
    add mac-address=$macSonde type=bypassed comment="wakatnet-labo sonde"
  }
}

# ---------------------------------------------------------------------------
# 4. Section C, facultative : tunnel WireGuard de labo terminé sur le routeur (variante R)
# ---------------------------------------------------------------------------
# Représente le vrai chemin de production : c'est le routeur qui chiffre
# (CPU d'un hAP lite MIPS compris). Plage 10.254.214.0/24, distincte de la
# variante L (10.254.213.0/24) : les deux tournent en même temps, et l'écart
# L / R se mesure au même moment. Les VM portent alors une seconde adresse
# (serveur-vm.sh : WG_ADRESSE_R=10.254.214.1/24 pour fsn, .2 nbg, .3 hel).
# La sonde Linux emprunte ce tunnel par une route 10.254.214.0/24 via le
# routeur ; le routeur masque le LAN derrière son adresse de tunnel.
# Port 13299 : vérifier qu'il est libre. Hors overlay de production 10.213.0.0/16.
# La clé privée est générée par RouterOS à la création de l'interface ; on ne
# recopie vers les VM que la clé publique.
# Toute cette section : (syntaxe à confirmer sur CHR).
:if ($avecTunnel) do={
  /interface wireguard
  :if ([:len [find name="wg-wakatnet-labo"]] = 0) do={
    add name=wg-wakatnet-labo listen-port=13299 mtu=1420 comment="wakatnet-labo tunnel de mesure"
  }
  /interface wireguard peers
  :if ([:len [find comment="wakatnet-labo fsn"]] = 0) do={
    add interface=wg-wakatnet-labo public-key="CLE_PUBLIQUE_VM_FSN" endpoint-address=IP_PUBLIQUE_VM_FSN \
        endpoint-port=51820 allowed-address=10.254.214.1/32 persistent-keepalive=25s comment="wakatnet-labo fsn"
  }
  :if ([:len [find comment="wakatnet-labo nbg"]] = 0) do={
    add interface=wg-wakatnet-labo public-key="CLE_PUBLIQUE_VM_NBG" endpoint-address=IP_PUBLIQUE_VM_NBG \
        endpoint-port=51820 allowed-address=10.254.214.2/32 persistent-keepalive=25s comment="wakatnet-labo nbg"
  }
  :if ([:len [find comment="wakatnet-labo hel"]] = 0) do={
    add interface=wg-wakatnet-labo public-key="CLE_PUBLIQUE_VM_HEL" endpoint-address=IP_PUBLIQUE_VM_HEL \
        endpoint-port=51820 allowed-address=10.254.214.3/32 persistent-keepalive=25s comment="wakatnet-labo hel"
  }
  /ip address
  :if ([:len [find comment="wakatnet-labo tunnel de mesure"]] = 0) do={
    add address=$adresseTunnelR interface=wg-wakatnet-labo comment="wakatnet-labo tunnel de mesure"
  }
  # Ajoutée en fin de chaîne srcnat : ne réordonne rien. Si le pare-feu
  # « forward » existant bloque LAN -> wg-wakatnet-labo, l'adapter à la main.
  /ip firewall nat
  :if ([:len [find comment="wakatnet-labo sonde LAN vers tunnel"]] = 0) do={
    add chain=srcnat out-interface=wg-wakatnet-labo action=masquerade \
        comment="wakatnet-labo sonde LAN vers tunnel"
  }
  /tool netwatch
  :foreach nom,ip in={"fsn-wgr"="10.254.214.1"; "nbg-wgr"="10.254.214.2"; "hel-wgr"="10.254.214.3"} do={
    :if ([:len [find comment=("wakatnet-labo netwatch " . $nom)]] = 0) do={
      add host=$ip type=icmp interval=1m packet-count=20 packet-interval=200ms \
          comment=("wakatnet-labo netwatch " . $nom)
    }
  }
  :put "Clé publique du tunnel de labo (à passer à serveur-vm.sh ajouter-pair NOM CLE ADRESSE_R) :"
  :put [/interface wireguard get [find name="wg-wakatnet-labo"] public-key]
}

:log info "wakatnet-labo sonde installee"
:put "wakatnet-labo : sonde secondaire installée (journal en syslog vers la sonde Linux, port 5514)."
}

# ---------------------------------------------------------------------------
# PHASE CLAIRSEMÉE (PROTOCOLE §5.6 bis) : couper les sondes ICMP du routeur,
# qui réveilleraient la radio toutes les minutes. À coller à la main
# (syntaxe à confirmer sur CHR) :
# /system scheduler disable [find name="wakatnet-labo-netwatch"]
# /system scheduler disable [find name="wakatnet-labo-ping"]
# /tool netwatch disable [find comment~"^wakatnet-labo"]
# (et « enable » à la place de « disable » pour revenir à la phase dense)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# RETRAIT (à coller à la main en fin de mesure ; retire tout ce qui porte
# le commentaire ou le nom wakatnet-labo / wklabo, rien d'autre). Copier
# d'abord les fichiers wakatnet-labo-latence*.txt s'il y en a.
# ---------------------------------------------------------------------------
# /system scheduler remove [find comment~"^wakatnet-labo"]
# /system script remove [find comment~"^wakatnet-labo"]
# /tool netwatch remove [find comment~"^wakatnet-labo"]
# /system logging remove [find comment~"^wakatnet-labo"]
# /system logging action remove [find name="wklabo"]
# /system logging action remove [find name="wklabodisque"]
# /ip hotspot ip-binding remove [find comment~"^wakatnet-labo"]
# /ip firewall nat remove [find comment~"^wakatnet-labo"]
# /ip address remove [find comment~"^wakatnet-labo"]
# /interface wireguard peers remove [find comment~"^wakatnet-labo"]
# /interface wireguard remove [find comment~"^wakatnet-labo"]
# /file remove [find name~"wakatnet-labo-latence"]
