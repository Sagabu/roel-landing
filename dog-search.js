// Global Dog Search Component
// Include this on all pages to add search functionality

(function() {
    // Cache for search results
    let searchCache = {};
    let searchTimeout = null;

    // Create search modal HTML
    function createSearchModal() {
        const modal = document.createElement('div');
        modal.id = 'globalSearchModal';
        modal.className = 'fixed inset-0 bg-black/60 z-[100] hidden flex items-start justify-center pt-20 px-4';
        modal.innerHTML = `
            <div class="bg-white rounded-2xl max-w-2xl w-full max-h-[70vh] overflow-hidden shadow-2xl" onclick="event.stopPropagation()">
                <div class="p-4 border-b border-bark-200">
                    <div class="relative">
                        <svg class="w-5 h-5 text-bark-400 absolute left-4 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                        </svg>
                        <input type="text" id="globalSearchInput"
                            placeholder="Søk på hundenavn eller registreringsnummer..."
                            class="w-full pl-12 pr-4 py-3 rounded-xl border-2 border-bark-200 focus:border-forest-500 focus:ring-0 outline-none text-lg"
                            autocomplete="off">
                        <button onclick="closeGlobalSearch()" class="absolute right-3 top-1/2 -translate-y-1/2 text-bark-400 hover:text-bark-600 p-1">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div id="globalSearchResults" class="overflow-y-auto max-h-[50vh] p-4">
                    <p class="text-center text-bark-500 py-8">Skriv for å søke etter hunder...</p>
                </div>
            </div>
        `;
        modal.onclick = function() { closeGlobalSearch(); };
        document.body.appendChild(modal);

        // Add event listener for search input
        document.getElementById('globalSearchInput').addEventListener('input', function(e) {
            performSearch(e.target.value);
        });

        // Close on escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeGlobalSearch();
        });
    }

    // Create search button for header
    function createSearchButton() {
        const btn = document.createElement('button');
        btn.id = 'globalSearchBtn';
        btn.className = 'bg-white/10 hover:bg-white/20 text-white px-3 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2';
        btn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <span class="hidden sm:inline">Søk hund</span>
        `;
        btn.onclick = openGlobalSearch;
        return btn;
    }

    // Prize color helper
    function getPrizeClass(prize) {
        if (['CACIT', 'ResCacit'].some(p => prize.includes(p)) || prize.includes('1')) return 'bg-amber-100 text-amber-700';
        if (prize.includes('CK') || prize.includes('2')) return 'bg-green-100 text-green-700';
        if (['Finale', 'Semifinale'].some(p => prize.includes(p))) return 'bg-blue-100 text-blue-700';
        if (prize.includes('3') || prize.includes('ÅP') || prize.includes('AP')) return 'bg-earth-100 text-earth-700';
        return 'bg-bark-100 text-bark-600';
    }

    // Search function - fetches from API
    async function performSearch(query) {
        const resultsContainer = document.getElementById('globalSearchResults');

        if (!query || query.length < 2) {
            resultsContainer.innerHTML = '<p class="text-center text-bark-500 py-8">Skriv minst 2 tegn for å søke...</p>';
            return;
        }

        // Show loading
        resultsContainer.innerHTML = '<p class="text-center text-bark-500 py-8">Søker...</p>';

        // Debounce
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
            try {
                const response = await fetch(`/api/hunder?search=${encodeURIComponent(query)}`);
                const dogs = await response.json();

                if (dogs.length === 0) {
                    resultsContainer.innerHTML = `
                        <p class="text-center text-bark-500 py-8">
                            Ingen hunder funnet for "${query}"
                        </p>
                    `;
                    return;
                }

                resultsContainer.innerHTML = dogs.map(dog => `
                    <div class="p-4 hover:bg-bark-50 rounded-xl cursor-pointer transition border border-transparent hover:border-bark-200"
                         onclick="viewDogProfile('${dog.id}')">
                        <div class="flex items-start gap-4">
                            ${dog.bilde ? `
                                <img src="${dog.bilde}" alt="${dog.navn}" class="w-14 h-14 rounded-xl object-cover flex-shrink-0">
                            ` : `
                                <div class="w-14 h-14 bg-bark-100 rounded-xl flex items-center justify-center flex-shrink-0">
                                    <svg class="w-7 h-7 text-bark-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                                    </svg>
                                </div>
                            `}
                            <div class="flex-1 min-w-0">
                                <div class="flex items-start justify-between gap-2">
                                    <div>
                                        <h4 class="font-bold text-bark-800">${dog.navn}</h4>
                                        <p class="text-sm text-bark-500">${dog.rase || 'Ukjent rase'} • ${dog.kjonn === 'male' ? 'Hannhund' : 'Tispe'}</p>
                                    </div>
                                    <span class="text-xs bg-forest-100 text-forest-700 px-2 py-1 rounded-full font-medium">${dog.regnr || ''}</span>
                                </div>
                                <div class="mt-2 flex items-center gap-3 text-sm">
                                    <span class="text-bark-500">Eier: ${dog.eier_navn || 'Ukjent'}</span>
                                </div>
                            </div>
                            <svg class="w-5 h-5 text-bark-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                            </svg>
                        </div>
                    </div>
                `).join('');
            } catch (err) {
                console.error('Search error:', err);
                resultsContainer.innerHTML = '<p class="text-center text-red-500 py-8">Feil ved søk. Prøv igjen.</p>';
            }
        }, 200);
    }

    // Open search modal
    window.openGlobalSearch = function() {
        document.getElementById('globalSearchModal').classList.remove('hidden');
        document.getElementById('globalSearchInput').focus();
        document.body.style.overflow = 'hidden';
    };

    // Close search modal
    window.closeGlobalSearch = function() {
        document.getElementById('globalSearchModal').classList.add('hidden');
        document.getElementById('globalSearchInput').value = '';
        document.getElementById('globalSearchResults').innerHTML = '<p class="text-center text-bark-500 py-8">Skriv for å søke etter hunder...</p>';
        document.body.style.overflow = '';
    };

    // View dog profile
    window.viewDogProfile = function(dogId) {
        closeGlobalSearch();
        window.location.href = `hund.html?id=${dogId}`;
    };

    // Initialize when DOM is ready
    function init() {
        createSearchModal();

        // Find header nav and insert search button
        const navContainers = document.querySelectorAll('nav .flex.items-center.gap-3, nav .flex.gap-3.items-center, header .flex.items-center.gap-4, header .flex.items-center.gap-3');

        if (navContainers.length > 0) {
            // Insert at beginning of the nav actions
            const container = navContainers[navContainers.length - 1];
            const searchBtn = createSearchButton();
            container.insertBefore(searchBtn, container.firstChild);
        }

        // Also listen for Ctrl+K / Cmd+K to open search
        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                openGlobalSearch();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
