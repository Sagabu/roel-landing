/**
 * Klassevalidering for fuglehundprøver
 * Basert på Håndbok for Jaktprøvekomiteer 2025
 *
 * Klasser:
 * - UK (Unghundklasse): 9 mnd til 24 mnd
 * - AK (Åpen klasse): Fra fylte 2 år
 * - VK (Vinnerklasse): Etter oppnådd 1. AK
 *
 * Regler:
 * - Man kan ALDRI gå tilbake til lavere klasse (unntatt VK->AK er tillatt)
 * - Fyller hunden 2 år på dag 2/3 → starter UK dag 1, meldes AK dag 2/3
 * - Hund må være minimum 9 måneder på prøvedagen
 */

const KlasseValidator = {
    /**
     * Beregn hundens alder på en gitt dato
     * @param {string|Date} fodselsdato - Hundens fødselsdato
     * @param {string|Date} provedato - Dato for prøven
     * @returns {object} { years, months, days, totalMonths }
     */
    beregnAlder(fodselsdato, provedato) {
        const birth = new Date(fodselsdato);
        const trial = new Date(provedato);

        let years = trial.getFullYear() - birth.getFullYear();
        let months = trial.getMonth() - birth.getMonth();
        let days = trial.getDate() - birth.getDate();

        if (days < 0) {
            months--;
            const lastMonth = new Date(trial.getFullYear(), trial.getMonth(), 0);
            days += lastMonth.getDate();
        }

        if (months < 0) {
            years--;
            months += 12;
        }

        const totalMonths = years * 12 + months;

        return { years, months, days, totalMonths };
    },

    /**
     * Formater alder som lesbar tekst
     * @param {object} alder - Fra beregnAlder()
     * @returns {string} F.eks. "2 år og 3 mnd"
     */
    formaterAlder(alder) {
        if (alder.years === 0) {
            return `${alder.totalMonths} mnd`;
        } else if (alder.months === 0) {
            return `${alder.years} år`;
        } else {
            return `${alder.years} år og ${alder.months} mnd`;
        }
    },

    /**
     * Bestem riktig klasse basert på alder og historikk
     * @param {string|Date} fodselsdato - Hundens fødselsdato
     * @param {string|Date} provedato - Dato for prøvens første dag
     * @param {object} historikk - Hundens prøvehistorikk { harStartetAK: bool, har1AK: bool }
     * @returns {object} { klasse, forklaring, warnings, kanVelgeVK }
     */
    bestemKlasse(fodselsdato, provedato, historikk = {}) {
        const alder = this.beregnAlder(fodselsdato, provedato);
        const result = {
            klasse: null,
            forklaring: '',
            warnings: [],
            kanVelgeVK: false,
            alderTekst: this.formaterAlder(alder),
            totalMonths: alder.totalMonths
        };

        // Sjekk om hunden er for ung
        if (alder.totalMonths < 9) {
            result.klasse = 'FOR_UNG';
            result.forklaring = `Hunden er ${this.formaterAlder(alder)} og må være minst 9 måneder for å delta.`;
            result.warnings.push('Hunden er for ung til å delta på jaktprøve.');
            return result;
        }

        // Sjekk om hunden har startet i AK tidligere
        if (historikk.harStartetAK) {
            // Kan ikke gå tilbake til UK
            result.klasse = 'AK';

            // Hunder over 2 år hører til i AK
            result.forklaring = `Hunden er ${this.formaterAlder(alder)} og hører til i AK (Åpen klasse).`;

            // Sjekk om hunden har 1. AK
            if (historikk.har1AK) {
                result.kanVelgeVK = true;
                result.forklaring += ' Hunden har oppnådd 1. AK og kan stille i VK.';
            }

            return result;
        }

        // Sjekk alder for klasseinndeling
        if (alder.totalMonths < 24) {
            // Under 2 år = UK
            result.klasse = 'UK';
            result.forklaring = `Hunden er under 2 år og må meldes på i UK.`;

            // Sjekk om hunden fyller 2 år under prøven
            const dag2 = new Date(provedato);
            dag2.setDate(dag2.getDate() + 1);
            const dag3 = new Date(provedato);
            dag3.setDate(dag3.getDate() + 2);

            const alderDag2 = this.beregnAlder(fodselsdato, dag2);
            const alderDag3 = this.beregnAlder(fodselsdato, dag3);

            if (alderDag2.years >= 2 || alderDag3.years >= 2) {
                result.warnings.push(`OBS: Hunden fyller 2 år under prøven. Start i UK dag 1, men må meldes i AK fra dag ${alderDag2.years >= 2 ? 2 : 3}.`);
            }
        } else {
            // 2 år eller eldre = AK
            result.klasse = 'AK';
            result.forklaring = `Hunden er ${this.formaterAlder(alder)} og hører til i AK (Åpen klasse).`;

            // Sjekk om hunden har 1. AK
            if (historikk.har1AK) {
                result.kanVelgeVK = true;
                result.forklaring += ' Hunden har oppnådd 1. AK og kan stille i VK.';
            }
        }

        return result;
    },

    /**
     * Valider at en klassevalg er gyldig
     * @param {string} valgtKlasse - UK, AK eller VK
     * @param {string|Date} fodselsdato - Hundens fødselsdato
     * @param {string|Date} provedato - Dato for prøven
     * @param {object} historikk - Hundens prøvehistorikk
     * @returns {object} { gyldig, feilmelding }
     */
    validerKlassevalg(valgtKlasse, fodselsdato, provedato, historikk = {}) {
        const anbefalt = this.bestemKlasse(fodselsdato, provedato, historikk);

        if (anbefalt.klasse === 'FOR_UNG') {
            return { gyldig: false, feilmelding: anbefalt.forklaring };
        }

        // UK-validering
        if (valgtKlasse === 'UK') {
            if (anbefalt.totalMonths >= 24) {
                return { gyldig: false, feilmelding: 'Hunden er 2 år eller eldre og kan ikke starte i UK.' };
            }
            if (historikk.harStartetAK) {
                return { gyldig: false, feilmelding: 'Hunden har tidligere startet i AK og kan ikke gå tilbake til UK.' };
            }
        }

        // VK-validering
        if (valgtKlasse === 'VK') {
            if (!historikk.har1AK) {
                return { gyldig: false, feilmelding: 'Hunden må ha oppnådd 1. AK for å starte i VK.' };
            }
        }

        return { gyldig: true, feilmelding: null };
    },

    /**
     * Sjekk om hunden kan delta på en gitt prøvedag
     * @param {string|Date} fodselsdato - Hundens fødselsdato
     * @param {string|Date} provedato - Dato for prøven
     * @returns {object} { kanDelta, grunn }
     */
    kanDeltaPaProve(fodselsdato, provedato) {
        const alder = this.beregnAlder(fodselsdato, provedato);

        if (alder.totalMonths < 9) {
            return {
                kanDelta: false,
                grunn: `Hunden må være minst 9 måneder. På prøvedagen er hunden ${this.formaterAlder(alder)}.`
            };
        }

        return { kanDelta: true, grunn: null };
    }
};

// Eksporter for bruk i andre filer
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KlasseValidator;
}
