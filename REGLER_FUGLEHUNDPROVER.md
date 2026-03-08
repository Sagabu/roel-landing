# Regler for Fuglehundprøver (FKF/NISK)

Dette dokumentet inneholder offisielle regler som MÅ følges i all kode og seed-data.

---

## Klasseinndeling

| Klasse | Alder | Beskrivelse |
|--------|-------|-------------|
| **UK** | 9 mnd – 2 år | Unghundklasse |
| **AK** | Fra fylte 2 år | Åpen klasse |
| **VK** | Etter 1. AK | Vinnerklasse (krever 1. AK-premie) |

### Progresjon
- Hunden starter i UK (fra 9 mnd)
- Ved fylte 2 år → AK
- Etter oppnådd 1. AK → kan delta i VK
- **Man kan ALDRI gå tilbake til lavere klasse**

---

## Krav for 1. premie

### Slipptid
- **Minimum 60 minutter** slipptid kreves for 1. premie (UK, AK, VK)
- 60+ minutter garanterer IKKE 1. premie – andre kriterier må også oppfylles
- 2. og 3. premie kan ha 60+ minutter hvis andre kriterier ikke oppfylles

### 1. AK spesifikke krav (gir VK-kvalifisering)
Hunden må være **"ren"**:
- ✓ Fuglearbeid med godkjent reis
- ✓ **Ingen makkerstand** (makker_stand = 0)
- ✓ **Ingen sjanse på fugl** (sjanse = 0)
- ✓ Ingen tomstand (tomstand = 0)
- ✓ Slipptid ≥ 60 minutter

### 1. UK krav
- ✓ Fuglearbeid med godkjent reis
- ✓ Ingen makkerstand
- ✓ Ingen sjanse
- ✓ Slipptid ≥ 60 minutter

---

## Avlsindekser (NISK-modell)

Referanse: "Avlsindekser på irsksetter", Avlsrådet NISK 2008

### Indeks-skala
- **100 = rasens gjennomsnitt** for siste generasjon
- Over 100 = bedre enn rasesnitt
- Under 100 = dårligere enn rasesnitt
- Ved parring: samlet indeks bør være **over 200** for avlsfremgang

### Offisielle avlsindekser
1. **Jaktlyst** – gjennomsnittlig tallkarakter (1-6)
2. **Viltfinnerevne** – gjennomsnittlig antall stander per prøve (stand_m + stand_u)
3. **HD** – hofteleddsdysplasi (ikke relevant for jaktstatistikk)

### Minimumskrav
- **5 prøvestarter** kreves for pålitelig avlsindeks
- Færre starter = lav sikkerhet på indeks

### Egenskaper som IKKE brukes i avlsindeks
- **Fart/stil** – korrelerer 95%+ med jaktlyst (samme gener)
- **Selvstendighet, søksbredde, reviering, samarbeid** – høyeste karakter er ikke best
- **Reis** – registreres ikke ved hvert fuglearbeid, styres ikke av hunden selv

### Prøveformer
- Høyfjell og lavland inkluderes
- **Skogsfuglprøver ekskluderes** (mangler makkerkonkurranse)

---

## Kritikkskjema-felt

### Fuglebehandling
| Felt | Skala | Beskrivelse |
|------|-------|-------------|
| presisjon | 1-4 | 1=meget upresis, 2=upresis, 3=noe upresis, 4=presis |
| reising | 1-6 | 1=nekter, 2=svært forsiktig, 3=forsiktig, 4=kontrollert, 5=villig, 6=djerv |
| godkjent_reising | 0/1 | Ja/Nei |

### Stand og arbeid
| Felt | Type | Beskrivelse |
|------|------|-------------|
| stand_m | Antall | Stand med makker |
| stand_u | Antall | Stand uten makker |
| tomstand | Antall | Tomme stander |
| makker_stand | Antall | Makkers stand (hunden sekunderer) |
| sjanse | Antall | Sjanser på fugl (utnyttet/ikke) |
| slipptid | Minutter | Tid i terrenget |

### Egenskaper (1-6 skala)
- jaktlyst, fart, selvstendighet, soksbredde, reviering, samarbeid

### Sekundering
| Felt | Type | Beskrivelse |
|------|------|-------------|
| sek_spontan | Antall | Spontan sekundering |
| sek_forbi | Antall | Går forbi (ikke sekunderer) |

### Andre
| Felt | Type | Beskrivelse |
|------|------|-------------|
| apport | 1/2/null | 1=godkjent, 2=ikke godkjent, null=ikke testet |
| rapport_spontan | 0/1 | Spontan rapportering |
| adferd | Tekst | Uønsket adferd |
| premie | Tekst | Oppnådd premie |

---

## Rasesnitt Irsk Setter (referanseverdier)

| Egenskap | Rasesnitt |
|----------|-----------|
| Viltfinnerevne | 2.45 stander/prøve |
| Jaktlyst | 4.8 |
| Andel tomstand | 12.5% |
| Fart | 4.6 |
| Søksbredde | 4.2 |
| Reviering | 4.1 |
| Samarbeid | 4.3 |
| Presisjon | 3.2 |
| Premiert | 42% |

---

## Eksempel: Gyldig prøvehistorikk

Hund født: 2021-11-30 (fyller 2 år: 2023-11-30)

| Dato | Alder | Klasse | Slipptid | Makkerst. | Sjanse | Premie |
|------|-------|--------|----------|-----------|--------|--------|
| 2023-05-14 | 1,5 år | UK | 55 min | 0 | 2 | 3. UK |
| 2023-09-16 | 1 år 10 mnd | UK | 65 min | 0 | 0 | **1. UK** |
| 2024-04-20 | 2 år 4 mnd | AK | 62 min | 1 | 1 | 2. AK |
| 2024-09-28 | 2 år 10 mnd | AK | 70 min | 0 | 0 | **1. AK** → VK! |
| 2024-10-12 | 2 år 11 mnd | AK | 65 min | 0 | 1 | 2. AK |

---

*Sist oppdatert: 2026-03-08*
