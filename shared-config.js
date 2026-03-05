/**
 * Shared Tailwind configuration and design tokens for Fuglehundprøve
 * Include this file BEFORE tailwindcss in all HTML files
 */

// Tailwind configuration - must be set before Tailwind loads
window.tailwind = window.tailwind || {};
window.tailwind.config = {
    theme: {
        extend: {
            colors: {
                // Main layout background color
                cream: {
                    DEFAULT: '#E7DAC8',
                    50: '#FAF7F3',
                    100: '#F5F0E8',
                    200: '#E7DAC8',
                    300: '#D4C4A8',
                    400: '#C1AE88',
                    500: '#AE9868',
                },
                forest: {
                    50: '#f6f7f4',
                    100: '#e3e7dc',
                    200: '#c7d0ba',
                    300: '#a4b391',
                    400: '#839770',
                    500: '#657a53',
                    600: '#4f6040',
                    700: '#3f4c34',
                    800: '#343e2d',
                    900: '#2c3526',
                    950: '#151a12',
                },
                earth: {
                    50: '#faf6f2',
                    100: '#f3ebe0',
                    200: '#e6d5c0',
                    300: '#d5b899',
                    400: '#c49a72',
                    500: '#b88255',
                    600: '#aa6e48',
                    700: '#8e583d',
                    800: '#734837',
                    900: '#5e3c2f',
                    950: '#321e17',
                },
                bark: {
                    50: '#f7f5f4',
                    100: '#edeae7',
                    200: '#ddd6d0',
                    300: '#c7bcb2',
                    400: '#ae9d90',
                    500: '#9a8677',
                    600: '#8d776a',
                    700: '#756259',
                    800: '#61524b',
                    900: '#50453f',
                    950: '#2a2321',
                }
            },
            fontFamily: {
                'rockwell': ['Rockwell', 'Rockwell Nova', 'Roboto Slab', 'Georgia', 'serif']
            }
        }
    }
};

// Shared styles that need to be injected
const sharedStyles = `
    .font-rockwell {
        font-family: 'Rockwell', 'Rockwell Nova', 'Roboto Slab', Georgia, serif;
    }
`;

// Inject shared styles
if (typeof document !== 'undefined') {
    const styleEl = document.createElement('style');
    styleEl.textContent = sharedStyles;
    document.head.appendChild(styleEl);
}
