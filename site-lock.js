/**
 * Site-wide passordbeskyttelse
 *
 * Viser en PIN-skjerm før siden lastes.
 * PIN lagres i sessionStorage så brukeren slipper å taste inn på nytt.
 */
(function() {
  const LOCK_KEY = 'fuglehund_site_unlocked';
  const PIN_HASH_KEY = 'site_pin_hash';

  // Sjekk om allerede låst opp i denne session
  if (sessionStorage.getItem(LOCK_KEY) === 'true') {
    return; // Allerede låst opp
  }

  // Sjekk om site-lock er aktivert (hentes fra server)
  fetch('/api/site-lock/status')
    .then(r => r.json())
    .then(data => {
      if (!data.enabled) {
        sessionStorage.setItem(LOCK_KEY, 'true');
        return;
      }
      showLockScreen();
    })
    .catch(() => {
      // Hvis API feiler, vis siden likevel
      sessionStorage.setItem(LOCK_KEY, 'true');
    });

  function showLockScreen() {
    // Skjul alt innhold
    document.body.style.visibility = 'hidden';

    // Opprett lock overlay
    const overlay = document.createElement('div');
    overlay.id = 'site-lock-overlay';
    overlay.innerHTML = `
      <style>
        #site-lock-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(135deg, #1a3a2a 0%, #2d5a3d 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 99999;
          font-family: system-ui, -apple-system, sans-serif;
        }
        #site-lock-box {
          background: white;
          padding: 2rem;
          border-radius: 1rem;
          box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
          text-align: center;
          max-width: 320px;
          width: 90%;
        }
        #site-lock-box h2 {
          color: #1a3a2a;
          margin: 0 0 0.5rem 0;
          font-size: 1.5rem;
        }
        #site-lock-box p {
          color: #666;
          margin: 0 0 1.5rem 0;
          font-size: 0.875rem;
        }
        #site-lock-input {
          width: 100%;
          padding: 0.75rem;
          font-size: 1.5rem;
          text-align: center;
          letter-spacing: 0.5rem;
          border: 2px solid #ddd;
          border-radius: 0.5rem;
          margin-bottom: 1rem;
          box-sizing: border-box;
        }
        #site-lock-input:focus {
          outline: none;
          border-color: #2d5a3d;
        }
        #site-lock-btn {
          width: 100%;
          padding: 0.75rem;
          background: #2d5a3d;
          color: white;
          border: none;
          border-radius: 0.5rem;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
        }
        #site-lock-btn:hover {
          background: #1a3a2a;
        }
        #site-lock-error {
          color: #dc2626;
          font-size: 0.875rem;
          margin-top: 0.5rem;
          display: none;
        }
      </style>
      <div id="site-lock-box">
        <h2>Fuglehundprøve</h2>
        <p>Denne siden er under utvikling.<br>Tast inn PIN for å fortsette.</p>
        <input type="password" id="site-lock-input" maxlength="6" placeholder="PIN" autocomplete="off">
        <button id="site-lock-btn">Lås opp</button>
        <div id="site-lock-error">Feil PIN. Prøv igjen.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.body.style.visibility = 'visible';

    const input = document.getElementById('site-lock-input');
    const btn = document.getElementById('site-lock-btn');
    const error = document.getElementById('site-lock-error');

    input.focus();

    async function tryUnlock() {
      const pin = input.value;
      if (!pin) return;

      btn.textContent = 'Sjekker...';
      btn.disabled = true;

      try {
        const resp = await fetch('/api/site-lock/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });

        if (resp.ok) {
          sessionStorage.setItem(LOCK_KEY, 'true');
          overlay.remove();
          // Reload for å vise innholdet
          window.location.reload();
        } else {
          error.style.display = 'block';
          input.value = '';
          input.focus();
          btn.textContent = 'Lås opp';
          btn.disabled = false;
        }
      } catch (e) {
        error.textContent = 'Noe gikk galt. Prøv igjen.';
        error.style.display = 'block';
        btn.textContent = 'Lås opp';
        btn.disabled = false;
      }
    }

    btn.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryUnlock();
      error.style.display = 'none';
    });
  }
})();
