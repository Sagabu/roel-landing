/**
 * Felles feilhåndtering for Fuglehundprøve
 * Inkluder dette scriptet på alle sider for brukervennlige feilmeldinger
 */

window.FuglehundError = {
  // Vis brukervennlig feilmelding
  show: function(message, type = 'error', duration = 5000) {
    const existing = document.getElementById('fuglehund-toast');
    if (existing) existing.remove();

    const colors = {
      error: 'bg-red-600',
      warning: 'bg-amber-500',
      success: 'bg-green-600',
      info: 'bg-blue-600'
    };

    const icons = {
      error: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      warning: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>',
      success: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>',
      info: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
    };

    const toast = document.createElement('div');
    toast.id = 'fuglehund-toast';
    toast.className = `fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 ${colors[type]} text-white px-4 py-3 rounded-xl shadow-lg z-[9999] flex items-start gap-3 animate-slide-up`;
    toast.innerHTML = `
      <svg class="w-6 h-6 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        ${icons[type]}
      </svg>
      <div class="flex-1">
        <p class="font-medium">${message}</p>
      </div>
      <button onclick="this.parentElement.remove()" class="text-white/70 hover:text-white">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    `;

    // Legg til animation style hvis ikke finnes
    if (!document.getElementById('fuglehund-toast-style')) {
      const style = document.createElement('style');
      style.id = 'fuglehund-toast-style';
      style.textContent = `
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-slide-up { animation: slide-up 0.3s ease-out; }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => toast.remove(), duration);
    }
  },

  // Håndter API-feil
  handleApiError: function(error, context = '') {
    console.error(`[API Error${context ? ` - ${context}` : ''}]:`, error);

    let message = 'Noe gikk galt. Prøv igjen.';

    if (error.message) {
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        message = 'Ingen internettilkobling. Sjekk nettverket ditt.';
      } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        message = 'Du er ikke innlogget. Logg inn på nytt.';
      } else if (error.message.includes('403') || error.message.includes('Forbidden')) {
        message = 'Du har ikke tilgang til denne funksjonen.';
      } else if (error.message.includes('404')) {
        message = 'Ressursen ble ikke funnet.';
      } else if (error.message.includes('409')) {
        message = error.message; // Duplikat-feil har ofte god beskjed
      } else if (error.message.includes('500')) {
        message = 'Serverfeil. Prøv igjen senere.';
      } else {
        message = error.message;
      }
    }

    this.show(message, 'error');
    return message;
  },

  // Wrapper for fetch med automatisk feilhåndtering
  fetch: async function(url, options = {}, context = '') {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('fuglehund_token')
            ? { 'Authorization': 'Bearer ' + localStorage.getItem('fuglehund_token') }
            : {}),
          ...options.headers
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      this.handleApiError(error, context);
      throw error;
    }
  },

  // Bekreftelsesdialog
  confirm: function(message, onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-black/50 z-[9999] flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <p class="text-bark-800 mb-6">${message}</p>
        <div class="flex gap-3 justify-end">
          <button id="confirm-cancel" class="px-4 py-2 text-bark-600 hover:bg-bark-100 rounded-xl transition">
            Avbryt
          </button>
          <button id="confirm-ok" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl transition">
            Bekreft
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-cancel').onclick = () => {
      overlay.remove();
      if (onCancel) onCancel();
    };

    overlay.querySelector('#confirm-ok').onclick = () => {
      overlay.remove();
      if (onConfirm) onConfirm();
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        if (onCancel) onCancel();
      }
    };
  }
};

// Globalt feilhåndtering for uncaught errors
window.addEventListener('unhandledrejection', function(event) {
  console.error('Unhandled promise rejection:', event.reason);
  // Ikke vis toast for alle unhandled rejections, bare logg
});

// Eksporter som global
window.showError = (msg) => FuglehundError.show(msg, 'error');
window.showWarning = (msg) => FuglehundError.show(msg, 'warning');
window.showSuccess = (msg) => FuglehundError.show(msg, 'success');
window.showInfo = (msg) => FuglehundError.show(msg, 'info');
