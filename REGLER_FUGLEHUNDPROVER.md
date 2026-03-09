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

## Validering av kritikkskjema (OBLIGATORISK)

### Felt som ALLTID må fylles ut

| Felt | Krav |
|------|------|
| **Slipptid** | MÅ alltid være med på alle kritikker |
| **Jaktlyst** | MÅ fylles ut (1-6) |
| **Fart** | MÅ fylles ut (1-6) |
| **Selvstendighet** | MÅ fylles ut (1-6) |
| **Søksbredde** | MÅ fylles ut (1-6) |
| **Reviering** | MÅ fylles ut (1-6) |
| **Samarbeid** | MÅ fylles ut (1-6) |

**Alle egenskaper (1-6 skala) MÅ fylles ut - ingen ruter kan stå tomme!**

### Automatisk validering: Godkjent reis

Hvis hunden har fuglearbeid (stand_m > 0 ELLER stand_u > 0) OG reis er satt (reising > 0):
- → **godkjent_reising MÅ være huket av (= 1)**

```javascript
// Valideringslogikk
if ((stand_m > 0 || stand_u > 0) && reising > 0) {
    godkjent_reising = 1; // MÅ være true
}
```

### Oppsummering valideringsregler

1. ❌ Kritikk uten slipptid = UGYLDIG
2. ❌ Kritikk med tomme egenskapsruter = UGYLDIG
3. ❌ Fuglearbeid + reis uten godkjent_reising = UGYLDIG

---

## Avlsindekser (Raseklubb-modell)

Basert på NISK-dokumentasjon "Avlsindekser på irsksetter" (Avlsrådet NISK 2008), utvidet til alle fuglehundraser.

### Støttede raser og raseklubber

#### Settere og Pointer
| Rase | Klubb | Viltfinnerevne (snitt) | Jaktlyst (snitt) |
|------|-------|------------------------|------------------|
| Irsk Setter | NISK | 2.45 | 4.8 |
| Engelsk Setter | NESK | 2.65 | 4.9 |
| Gordon Setter | NGSK | 2.30 | 4.5 |
| Pointer | NPK | 2.55 | 5.1 |

#### Vorsteh-raser (Kontinentale fuglehunder)
| Rase | Klubb | Viltfinnerevne (snitt) | Jaktlyst (snitt) |
|------|-------|------------------------|------------------|
| Deutsch Kurzhaar | NDKK | 2.35 | 4.6 |
| Deutsch Drahthaar | NDDK | 2.30 | 4.5 |
| Deutsch Langhaar | NDLK | 2.25 | 4.4 |
| Kleiner Münsterländer | NKMK | 2.20 | 4.5 |
| Grosser Münsterländer | NGMK | 2.30 | 4.5 |
| Weimaraner | NWK | 2.40 | 4.7 |
| Vizsla | NVK | 2.35 | 4.8 |
| Braque Francais | NBFK | 2.30 | 4.6 |
| Breton | NBK | 2.45 | 4.9 |
| Spinone Italiano | NSIK | 2.15 | 4.2 |

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

## Implementert i koden

### API-endepunkter for statistikk

| Endepunkt | Beskrivelse |
|-----------|-------------|
| `GET /api/hunder/:id/statistikk` | Avlsstatistikk for én hund |
| `GET /api/hunder/:id/kritikker` | Alle kritikker for én hund |
| `GET /api/hunder/:id/avkom` | Avkom for en hund |
| `GET /api/hunder/:id/avkom-statistikk` | Aggregert statistikk for avkom |

### Statistikk-beregninger (server.js: `beregnHundestatistikk()`)

```javascript
// Viltfinnerevne = (stand_m + stand_u) / antall_starter
viltfinnerevne: (stats.stand_m + stats.stand_u) / stats.starter

// Andel tomstand = tomstand / (stand_m + stand_u + tomstand) * 100
andel_tomstand: (stats.tomstand / totalStand) * 100

// Jaktlyst = gjennomsnitt av alle jaktlyst-karakterer
jaktlyst: stats.jaktlyst_sum / stats.jaktlyst_count

// Slipptid snitt
slipptid_snitt: stats.slipptid_sum / stats.slipptid_count
```

### NISK-indeks beregning (hund.html)

```javascript
// Indeks = (hundens verdi / rasesnitt) * 100
// 100 = rasesnitt, over 100 = bedre, under 100 = dårligere
function beregnIndeks(verdi, rasesnitt) {
    return Math.round((verdi / rasesnitt) * 100);
}

// Samlet avlsverdi = jaktlyst_indeks + viltfinnerevne_indeks
// Bør være over 200 for anbefalt avl
```

### Rasesnitt brukt i koden (hund.html: `RASESNITT_IRSK_SETTER`)

```javascript
const RASESNITT_IRSK_SETTER = {
    viltfinnerevne: 2.45,    // stander per prøve
    jaktlyst: 4.8,           // gjennomsnittlig karakter
    andel_tomstand: 12.5,    // prosent
    fart: 4.6,
    bredde: 4.2,
    reviering: 4.1,
    samarbeid: 4.3,
    presisjon: 3.2,
    premie_prosent: 42
};
```

### Sikkerhet på indeks

| Antall starter | Sikkerhet |
|----------------|-----------|
| < 5 | Lav (advarsel vises) |
| 5-9 | Middels |
| ≥ 10 | Høy |

### Statistikk-felt returnert fra API

```javascript
{
    starter: number,           // Antall prøvestarter
    stand_m: number,           // Totalt stand med makker
    stand_u: number,           // Totalt stand uten makker
    makker_stand: number,      // Totalt makkerstand
    tomstand: number,          // Totalt tomstand
    andel_tomstand: number,    // Prosent tomstand
    viltfinnerevne: number,    // Stander per prøve
    jaktlyst: number,          // Snitt 1-6
    fart: number,              // Snitt 1-6
    bredde: number,            // Snitt 1-6
    reviering: number,         // Snitt 1-6
    samarbeid: number,         // Snitt 1-6
    selvstendighet: number,    // Snitt 1-6
    slipptid_snitt: number,    // Snitt minutter
    sekundering: {
        spontan: number,
        forbi: number,
        total: number
    },
    reis: {
        nekter: number,
        svart_forsiktig: number,
        forsiktig: number,
        kontrollert: number,
        villig: number,
        djerv: number
    },
    presisjon: {
        meget_upresis: number,
        upresis: number,
        noe_upresis: number,
        presis: number,
        gjennomsnitt: number
    },
    premierte: number,
    premie_prosent: number
}
```

### Visning i avlsstatistikk (hund.html)

1. **Hovedtall**: Starter, stand m/, stand u/, makkerstand, tomstand, premiert %
2. **Avlsindekser**: Viltfinnerevne-indeks, Jaktlyst-indeks (begge med 100=rasesnitt)
3. **Sikkerhet**: Høy/Middels/Lav basert på antall starter
4. **Samlet avlsverdi**: Jaktlyst + Viltfinnerevne indeks (bør være ≥200)
5. **Fuglearbeid-detaljer**: Totale stander, makkerstand, tomstand, tomstand-andel
6. **Sekundering**: Spontan, går forbi, total
7. **Tallkarakterer**: Jaktlyst (avlsindeks), Fart (≈jaktlyst), Selvst., Bredde, Reviering, Samarb., Presisjon
8. **Reis-statistikk**: Fordeling nekter → djerv
9. **Presisjon-fordeling**: Meget upresis → presis

### Klassefiltrering

Statistikk kan filtreres per klasse:
- **Samlet** - alle prøver
- **UK** - kun unghundklasse
- **AK** - kun åpen klasse
- **VK** - kun vinnerklasse

NB: Skogsfuglprøver er ekskludert fra klassevalget (NISK-regel).

---

*Sist oppdatert: 2026-03-08*
