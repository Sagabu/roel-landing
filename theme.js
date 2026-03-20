// Fuglehundprøve Theme Configuration
// Brukes i alle HTML-filer via Tailwind CDN

const fuglehundTheme = {
    theme: {
        extend: {
            colors: {
                // Nye primærfarger
                warm: {
                    50: '#FFF7F2',   // Sekundær bakgrunn (kort, bokser)
                    100: '#FFE1CF',  // Hover-farge
                    200: '#EAD8CF',  // Linjefarge / skillelinjer
                    300: '#E5C9B8',
                    400: '#D4A989',
                    500: '#FD8536',  // Hovedaksentfarge (knapper, CTA)
                    600: '#E5721F',
                    700: '#C45F14',
                    800: '#6E3018',  // Mørk aksentfarge (overskrifter, viktige knapper)
                    900: '#4A1E0D',
                    950: '#2D1108'
                },
                // Bakgrunn
                cream: {
                    DEFAULT: '#F7F3EE',  // Primærfarge (hovedbakgrunn)
                    50: '#FFFFFF',
                    100: '#F7F3EE',      // Hovedbakgrunn
                    200: '#FFF7F2',      // Sekundær bakgrunn
                    300: '#EAD8CF'       // Linjer
                },
                // Beholder eksisterende for bakoverkompatibilitet, men oppdaterer verdier
                forest: {
                    50: '#FFF7F2',
                    100: '#FFE1CF',
                    200: '#EAD8CF',
                    300: '#D4A989',
                    400: '#C49370',
                    500: '#FD8536',  // Hovedaksentfarge
                    600: '#E5721F',
                    700: '#C45F14',
                    800: '#6E3018',  // Mørk aksentfarge
                    900: '#4A1E0D'
                },
                earth: {
                    50: '#FFF7F2',
                    100: '#FFE1CF',
                    200: '#EAD8CF',
                    300: '#D4A989',
                    400: '#C49370',
                    500: '#FD8536',
                    600: '#E5721F',
                    700: '#C45F14',
                    800: '#6E3018',
                    900: '#4A1E0D'
                },
                bark: {
                    50: '#F7F3EE',   // Hovedbakgrunn
                    100: '#FFF7F2',  // Sekundær bakgrunn
                    200: '#EAD8CF',  // Linjer
                    300: '#D4A989',
                    400: '#B8977A',
                    500: '#9A8268',
                    600: '#7D6A54',
                    700: '#6E3018',  // Mørk aksentfarge
                    800: '#5A2812',
                    900: '#3D1B0C'
                },
                // Aksent/CTA
                accent: {
                    DEFAULT: '#FD8536',
                    light: '#FFE1CF',
                    dark: '#6E3018'
                },
                // Sky beholdes for spesielle elementer
                sky: {
                    50: '#FFF7F2',
                    100: '#FFE1CF',
                    200: '#EAD8CF',
                    300: '#FD8536',
                    400: '#E5721F',
                    500: '#FD8536',
                    600: '#E5721F',
                    700: '#C45F14'
                }
            },
            fontFamily: {
                'rockwell': ['Rockwell', 'Georgia', 'serif'],
                'serif': ['Playfair Display', 'Georgia', 'serif'],
                'sans': ['Inter', 'system-ui', 'sans-serif']
            }
        }
    }
};

// Eksporter for bruk
if (typeof module !== 'undefined') {
    module.exports = fuglehundTheme;
}
