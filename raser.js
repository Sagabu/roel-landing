// Kanonisk rase-liste for stående fuglehunder på fuglehundprøver.
// Navnene matcher NKK DogWeb-formatet så import-filer stemmer 1:1.
// Alias-mapping håndterer vanlige varianter (eldre format, engelske/tyske
// navn, forkortelser) slik at alle skrivemåter normaliseres til én form.
//
// Brukes av:
//   - mine-hunder.html (opprett hund)
//   - admin.html (legg til hund manuelt)
//   - mine-hunder.html (aversjonsbevis rase)
//   - server.js (normalisering ved NKK-import)
//   - avlssok.html / admin-panel.html (filter-dropdowns)
//
// Legg til en ny rase her én gang, så er den tilgjengelig alle steder.

(function (global) {
  'use strict';

  // Kanoniske rasenavn, sortert alfabetisk for stabil visning
  const RASER = [
    'Breton',
    'Engelsk Setter',
    'Gordon Setter',
    'Grosser Münsterländer',
    'Irsk Rød og Hvit Setter',
    'Irsk Setter',
    'Italiensk Spinone',
    'Kleiner Münsterländer',
    'Pointer',
    'Ungarsk Vizsla Korthåret',
    'Ungarsk Vizsla Strihåret',
    'Vorstehhund Korthåret',
    'Vorstehhund Langhåret',
    'Vorstehhund Strihåret',
    'Weimaraner Korthåret',
    'Weimaraner Langhåret'
  ];

  // Kort ID per rase (to bokstaver, matcher dommer-ukak sin rase-badge)
  const RASE_KODE = {
    'Breton': 'B',
    'Engelsk Setter': 'ES',
    'Gordon Setter': 'GS',
    'Grosser Münsterländer': 'GM',
    'Irsk Rød og Hvit Setter': 'IRH',
    'Irsk Setter': 'IS',
    'Italiensk Spinone': 'IT',
    'Kleiner Münsterländer': 'KM',
    'Pointer': 'P',
    'Ungarsk Vizsla Korthåret': 'VK',
    'Ungarsk Vizsla Strihåret': 'VS',
    'Vorstehhund Korthåret': 'KV',
    'Vorstehhund Langhåret': 'LV',
    'Vorstehhund Strihåret': 'SV',
    'Weimaraner Korthåret': 'WK',
    'Weimaraner Langhåret': 'WL'
  };

  // Aliaser → kanonisk form. Normaliseringen er case-insensitiv og
  // renser mellomrom/diakritikk før oppslag.
  const ALIAS = {
    // Settere
    'engelsk setter': 'Engelsk Setter',
    'eng setter': 'Engelsk Setter',
    'es': 'Engelsk Setter',
    'english setter': 'Engelsk Setter',

    'gordon setter': 'Gordon Setter',
    'gs': 'Gordon Setter',

    'irsk setter': 'Irsk Setter',
    'is': 'Irsk Setter',
    'irish setter': 'Irsk Setter',
    'irsk roed setter': 'Irsk Setter',
    'irsk rød setter': 'Irsk Setter',

    'irsk rod og hvit setter': 'Irsk Rød og Hvit Setter',
    'irsk rød og hvit setter': 'Irsk Rød og Hvit Setter',
    'irsh red and white setter': 'Irsk Rød og Hvit Setter',
    'irrws': 'Irsk Rød og Hvit Setter',

    'pointer': 'Pointer',
    'p': 'Pointer',
    'english pointer': 'Pointer',

    // Vorsteh-varianter (NKK-format er "Vorstehhund <Hårlag>et")
    'vorstehhund korthaaret': 'Vorstehhund Korthåret',
    'vorstehhund korthåret': 'Vorstehhund Korthåret',
    'korthaar vorsteh': 'Vorstehhund Korthåret',
    'korthår vorsteh': 'Vorstehhund Korthåret',
    'korthaaret vorstehhund': 'Vorstehhund Korthåret',
    'korthåret vorstehhund': 'Vorstehhund Korthåret',
    'kv': 'Vorstehhund Korthåret',
    'deutsch kurzhaar': 'Vorstehhund Korthåret',
    'kurzhaar': 'Vorstehhund Korthåret',
    'german shorthaired pointer': 'Vorstehhund Korthåret',
    'gsp': 'Vorstehhund Korthåret',

    'vorstehhund strihaaret': 'Vorstehhund Strihåret',
    'vorstehhund strihåret': 'Vorstehhund Strihåret',
    'strihaar vorsteh': 'Vorstehhund Strihåret',
    'strihår vorsteh': 'Vorstehhund Strihåret',
    'strihaaret vorstehhund': 'Vorstehhund Strihåret',
    'strihåret vorstehhund': 'Vorstehhund Strihåret',
    'sv': 'Vorstehhund Strihåret',
    'deutsch drahthaar': 'Vorstehhund Strihåret',
    'drahthaar': 'Vorstehhund Strihåret',
    'german wirehaired pointer': 'Vorstehhund Strihåret',

    'vorstehhund langhaaret': 'Vorstehhund Langhåret',
    'vorstehhund langhåret': 'Vorstehhund Langhåret',
    'langhaar vorsteh': 'Vorstehhund Langhåret',
    'langhår vorsteh': 'Vorstehhund Langhåret',
    'langhaaret vorstehhund': 'Vorstehhund Langhåret',
    'langhåret vorstehhund': 'Vorstehhund Langhåret',
    'lv': 'Vorstehhund Langhåret',
    'deutsch langhaar': 'Vorstehhund Langhåret',
    'langhaar': 'Vorstehhund Langhåret',

    // Andre kontinentale
    'kleiner munsterlander': 'Kleiner Münsterländer',
    'kleiner münsterländer': 'Kleiner Münsterländer',
    'kleiner muensterlaender': 'Kleiner Münsterländer',
    'km': 'Kleiner Münsterländer',

    'grosser munsterlander': 'Grosser Münsterländer',
    'grosser münsterländer': 'Grosser Münsterländer',
    'grosser muensterlaender': 'Grosser Münsterländer',
    'gm': 'Grosser Münsterländer',
    'großer münsterländer': 'Grosser Münsterländer',

    'breton': 'Breton',
    'b': 'Breton',
    'epagneul breton': 'Breton',
    'brittany spaniel': 'Breton',
    'brittany': 'Breton',

    'weimaraner korthaaret': 'Weimaraner Korthåret',
    'weimaraner korthåret': 'Weimaraner Korthåret',
    'weimaraner': 'Weimaraner Korthåret', // uspesifisert → korthåret som default
    'wk': 'Weimaraner Korthåret',

    'weimaraner langhaaret': 'Weimaraner Langhåret',
    'weimaraner langhåret': 'Weimaraner Langhåret',
    'wl': 'Weimaraner Langhåret',

    'ungarsk vizsla korthaaret': 'Ungarsk Vizsla Korthåret',
    'ungarsk vizsla korthåret': 'Ungarsk Vizsla Korthåret',
    'magyar vizsla korthaaret': 'Ungarsk Vizsla Korthåret',
    'magyar vizsla korthåret': 'Ungarsk Vizsla Korthåret',
    'vizsla': 'Ungarsk Vizsla Korthåret', // uspesifisert → korthåret som default
    'vizsla korthåret': 'Ungarsk Vizsla Korthåret',
    'v': 'Ungarsk Vizsla Korthåret',

    'ungarsk vizsla strihaaret': 'Ungarsk Vizsla Strihåret',
    'ungarsk vizsla strihåret': 'Ungarsk Vizsla Strihåret',
    'magyar vizsla strihaaret': 'Ungarsk Vizsla Strihåret',
    'magyar vizsla strihåret': 'Ungarsk Vizsla Strihåret',
    'vizsla strihåret': 'Ungarsk Vizsla Strihåret',
    'drahthaar vizsla': 'Ungarsk Vizsla Strihåret',

    'italiensk spinone': 'Italiensk Spinone',
    'spinone italiano': 'Italiensk Spinone',
    'spinone': 'Italiensk Spinone'
  };

  // Renser tekst for normalisering: trim, case, diakritikk-blandinger
  function canonKey(s) {
    return String(s || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.,]/g, '')
      .replace(/[–—]/g, '-');
  }

  // Normaliser fritekst til kanonisk rasenavn.
  // Returnerer { rase, knownAlias } — rase er kanonisk hvis kjent, ellers
  // input-verdien tilbake (med trimming). knownAlias=true betyr at
  // oppslaget traff en alias/kanonisk form; false = ukjent rase.
  function normalizeRase(input) {
    const raw = String(input || '').trim();
    if (!raw) return { rase: '', knownAlias: false };
    const key = canonKey(raw);
    // Direkte alias-treff
    if (ALIAS[key]) return { rase: ALIAS[key], knownAlias: true };
    // Prøv å matche kanonisk form direkte
    for (const r of RASER) {
      if (canonKey(r) === key) return { rase: r, knownAlias: true };
    }
    // Ingen treff — returner opprinnelig input som-er (med trim) slik at
    // raser vi ikke har enn kan lagres, men de blir tydelig synlige
    // som "ikke-kanonisk" i UI.
    return { rase: raw, knownAlias: false };
  }

  function erKjentRase(input) {
    return normalizeRase(input).knownAlias;
  }

  // Hjelper som genererer <option>-elementer for en <select>.
  // placeholderText er tekst på default-option (tom value).
  function buildRaseOptions(selectedValue, placeholderText) {
    const opts = [`<option value="">${placeholderText || 'Velg rase'}</option>`];
    const selected = String(selectedValue || '').trim();
    const normalized = normalizeRase(selected).rase;
    for (const r of RASER) {
      const isSel = r === normalized ? ' selected' : '';
      opts.push(`<option value="${r}"${isSel}>${r}</option>`);
    }
    // Hvis valgt verdi ikke er i lista (legacy), vis den som egen opsjon
    // så brukeren ser hva som er lagret og kan bytte til en kanonisk form.
    if (selected && !RASER.includes(normalized)) {
      opts.push(`<option value="${selected}" selected>${selected} (ikke i listen)</option>`);
    }
    return opts.join('');
  }

  const API = { RASER, RASE_KODE, normalizeRase, erKjentRase, buildRaseOptions };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }
  global.Raser = API;
})(typeof window !== 'undefined' ? window : globalThis);
