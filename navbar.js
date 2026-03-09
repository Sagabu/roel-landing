/**
 * Shared navigation bar for Fuglehundprøve
 * Automatically detects user role and shows appropriate navigation
 */

(function() {
    'use strict';

    // Determine current page and user state
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    // Check login states - sjekker JWT først, deretter legacy localStorage
    function getUserState() {
        const jwtToken = localStorage.getItem('fuglehund_token');
        const jwtUser = localStorage.getItem('fuglehund_user');
        const userProfile = localStorage.getItem('userProfile');
        const judgeSession = localStorage.getItem('judgeSession');

        let user = null;
        let role = null;

        // Sjekk JWT-token først (nytt system)
        if (jwtToken && jwtUser) {
            try {
                // Verifiser at token ikke er utløpt
                const payload = JSON.parse(atob(jwtToken.split('.')[1]));
                if (payload.exp * 1000 > Date.now()) {
                    const userData = JSON.parse(jwtUser);
                    user = { name: `${userData.fornavn} ${userData.etternavn}`, phone: userData.telefon };
                    // Bestem rolle fra komma-separert liste
                    const roller = (userData.rolle || '').split(',').map(r => r.trim());
                    if (roller.includes('admin')) {
                        role = 'admin';
                    } else if (roller.includes('klubbleder') || roller.includes('proveleder')) {
                        role = 'admin';
                    } else if (roller.includes('dommer')) {
                        role = 'dommer';
                    } else {
                        role = 'deltaker';
                    }
                    return { user, role };
                }
            } catch (e) {}
        }

        // Fallback til legacy system
        if (judgeSession) {
            try {
                const session = JSON.parse(judgeSession);
                user = { name: session.name, phone: session.phone };
                role = session.isNkkRep ? 'nkk' : 'dommer';
            } catch (e) {}
        } else if (userProfile) {
            try {
                const profile = JSON.parse(userProfile);
                user = { name: profile.name, phone: profile.phone };
                role = profile.role || 'deltaker';
                // Check for admin role
                if (profile.isAdmin || profile.role === 'admin') {
                    role = 'admin';
                }
            } catch (e) {}
        }

        return { user, role };
    }

    // Define navigation items by role
    function getNavItems(role, currentPage) {
        const items = {
            public: [
                { href: 'index.html', label: 'Hjem', icon: 'home' },
                { href: 'partilister.html', label: 'Partilister', icon: 'list' }
            ],
            deltaker: [
                { href: 'index.html', label: 'Hjem', icon: 'home' },
                { href: 'profil.html', label: 'Min profil', icon: 'user' },
                { href: 'mine-hunder.html', label: 'Mine hunder', icon: 'dog' },
                { href: 'jaktprover.html', label: 'Jaktprøver', icon: 'trophy' },
                { href: 'fullmakter.html', label: 'Fullmakter', icon: 'document' }
            ],
            dommer: [
                { href: 'index.html', label: 'Hjem', icon: 'home' },
                { href: 'dommer-hjem.html', label: 'Mitt parti', icon: 'clipboard' },
                { href: 'profil.html', label: 'Min profil', icon: 'user' }
            ],
            nkk: [
                { href: 'index.html', label: 'Hjem', icon: 'home' },
                { href: 'nkk-godkjenning.html', label: 'Godkjenning', icon: 'check' },
                { href: 'profil.html', label: 'Min profil', icon: 'user' }
            ],
            admin: [
                { href: 'index.html', label: 'Hjem', icon: 'home' },
                { href: 'admin.html', label: 'Administrasjon', icon: 'settings' },
                { href: 'admin-panel.html', label: 'Systemadmin', icon: 'database' },
                { href: 'profil.html', label: 'Min profil', icon: 'user' }
            ]
        };

        return items[role] || items.public;
    }

    // SVG icons
    const icons = {
        home: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>',
        list: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
        user: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>',
        dog: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 2C9.5 2 7 3.5 6 6c-2 0-4 1.5-4 4 0 2 1.5 3.5 3 4-.5 1-1 2.5-1 4 0 3 2.5 4 5 4 1 0 2-.5 3-1 1 .5 2 1 3 1 2.5 0 5-1 5-4 0-1.5-.5-3-1-4 1.5-.5 3-2 3-4 0-2.5-2-4-4-4-1-2.5-3.5-4-6-4z"/>',
        trophy: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
        document: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
        clipboard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/>',
        check: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
        settings: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>',
        database: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>',
        menu: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>',
        close: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>'
    };

    function getIcon(name) {
        return `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${icons[name] || icons.home}</svg>`;
    }

    // Logo SVG
    const logoSvg = `<svg class="w-10 h-10 text-earth-400" fill="currentColor" viewBox="0 0 24 24">
        <path d="M12 2C9.5 2 7 3.5 6 6c-2 0-4 1.5-4 4 0 2 1.5 3.5 3 4-.5 1-1 2.5-1 4 0 3 2.5 4 5 4 1 0 2-.5 3-1 1 .5 2 1 3 1 2.5 0 5-1 5-4 0-1.5-.5-3-1-4 1.5-.5 3-2 3-4 0-2.5-2-4-4-4-1-2.5-3.5-4-6-4zm0 2c2 0 3.5 1 4 3h1c1.5 0 2.5 1 2.5 2.5 0 1-1 2-2 2.5l-.5.5.5 1c.5 1 1 2 1 3 0 1.5-1.5 2.5-3.5 2.5-.5 0-1.5-.5-2-1l-1-.5-1 .5c-.5.5-1.5 1-2 1-2 0-3.5-1-3.5-2.5 0-1 .5-2 1-3l.5-1-.5-.5c-1-.5-2-1.5-2-2.5C4.5 8 5.5 7 7 7h1c.5-2 2-3 4-3z"/>
    </svg>`;

    // Logout function - fjerner både legacy og JWT-tokens
    window.sharedLogout = function() {
        // Legacy localStorage keys
        localStorage.removeItem('userProfile');
        localStorage.removeItem('judgeSession');
        // JWT tokens
        localStorage.removeItem('fuglehund_token');
        localStorage.removeItem('fuglehund_user');
        // Redirect til forsiden
        window.location.href = 'index.html';
    };

    // Toggle mobile menu
    window.toggleMobileMenu = function() {
        const menu = document.getElementById('mobileMenu');
        const openIcon = document.getElementById('menuOpenIcon');
        const closeIcon = document.getElementById('menuCloseIcon');

        if (menu) {
            menu.classList.toggle('hidden');
            if (openIcon && closeIcon) {
                openIcon.classList.toggle('hidden');
                closeIcon.classList.toggle('hidden');
            }
        }
    };

    // Render navbar
    function renderNavbar() {
        const { user, role } = getUserState();
        const navItems = getNavItems(role || 'public', currentPage);

        // Check if navbar already exists (don't double-render)
        if (document.getElementById('shared-navbar')) return;

        // Find where to insert navbar (before body content or at start of body)
        const existingNav = document.querySelector('nav');
        if (existingNav && existingNav.dataset.sharedNavbar !== 'true') {
            // There's already a custom nav - don't override
            return;
        }

        const navHtml = `
            <nav id="shared-navbar" data-shared-navbar="true" class="fixed top-0 w-full bg-forest-900/95 backdrop-blur-sm shadow-lg z-50">
                <div class="max-w-6xl mx-auto px-4 py-4">
                    <div class="flex items-center justify-between">
                        <!-- Logo -->
                        <a href="index.html" class="flex items-center gap-3">
                            ${logoSvg}
                            <span class="text-2xl font-bold text-white font-rockwell hidden sm:inline">Fuglehundprøve</span>
                        </a>

                        <!-- Desktop Navigation -->
                        <div class="hidden md:flex items-center gap-1">
                            ${navItems.map(item => `
                                <a href="${item.href}"
                                   class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition
                                          ${currentPage === item.href
                                              ? 'bg-forest-700 text-white'
                                              : 'text-forest-200 hover:text-white hover:bg-forest-800'}">
                                    ${getIcon(item.icon)}
                                    <span>${item.label}</span>
                                </a>
                            `).join('')}
                        </div>

                        <!-- User Section -->
                        <div class="flex items-center gap-3">
                            ${user ? `
                                <span class="hidden sm:inline text-forest-200 text-sm">${user.name}</span>
                                <button onclick="sharedLogout()"
                                        class="text-forest-200 hover:text-white px-3 py-2 text-sm font-medium transition">
                                    Logg ut
                                </button>
                            ` : `
                                <a href="min-side.html"
                                   class="bg-earth-500 hover:bg-earth-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2">
                                    ${getIcon('user')}
                                    <span class="hidden sm:inline">Min side</span>
                                </a>
                            `}

                            <!-- Mobile Menu Button -->
                            <button onclick="toggleMobileMenu()" class="md:hidden text-forest-200 hover:text-white p-2">
                                <span id="menuOpenIcon">${getIcon('menu')}</span>
                                <span id="menuCloseIcon" class="hidden">${getIcon('close')}</span>
                            </button>
                        </div>
                    </div>

                    <!-- Mobile Menu -->
                    <div id="mobileMenu" class="hidden md:hidden mt-4 pt-4 border-t border-forest-700">
                        <div class="flex flex-col gap-1">
                            ${navItems.map(item => `
                                <a href="${item.href}"
                                   class="flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition
                                          ${currentPage === item.href
                                              ? 'bg-forest-700 text-white'
                                              : 'text-forest-200 hover:text-white hover:bg-forest-800'}">
                                    ${getIcon(item.icon)}
                                    <span>${item.label}</span>
                                </a>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </nav>
        `;

        // Insert navbar at the start of body
        document.body.insertAdjacentHTML('afterbegin', navHtml);

        // Add padding to body to account for fixed navbar
        document.body.style.paddingTop = '80px';
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderNavbar);
    } else {
        renderNavbar();
    }
})();
