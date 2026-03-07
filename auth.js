// auth.js — Client-side auth helper for Fuglehundprøve
// Manages tokens, login flow, and authenticated API calls

const Auth = {
  TOKEN_KEY: 'fuglehund_token',
  USER_KEY: 'fuglehund_user',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  getUser() {
    const raw = localStorage.getItem(this.USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  setSession(token, user) {
    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
    // Backward compat for pages that read these
    localStorage.setItem('userSession', JSON.stringify({
      phone: user.telefon,
      name: `${user.fornavn} ${user.etternavn}`,
      loggedInAt: new Date().toISOString()
    }));
    localStorage.setItem('userProfile', JSON.stringify({
      name: `${user.fornavn} ${user.etternavn}`,
      phone: user.telefon,
      loggedInAt: new Date().toISOString()
    }));
  },

  clearSession() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    localStorage.removeItem('userSession');
    localStorage.removeItem('userProfile');
    localStorage.removeItem('judgeSession');
  },

  // Authenticated fetch wrapper
  async fetch(url, options = {}) {
    const token = this.getToken();
    if (token) {
      options.headers = options.headers || {};
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, options);
    if (res.status === 401) {
      this.clearSession();
      // Redirect to login
      if (!window.location.pathname.includes('personvern')) {
        window.location.href = '/min-side.html';
      }
    }
    return res;
  },

  // Send OTP code
  async sendCode(telefon) {
    const res = await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefon })
    });
    return res.json();
  },

  // Verify OTP and get session
  async verifyCode(telefon, code) {
    const res = await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefon, code })
    });
    const data = await res.json();
    if (data.ok) {
      this.setSession(data.token, data.user);
    }
    return data;
  },

  async logout() {
    const token = this.getToken();
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }
    this.clearSession();
  },

  async giveConsent() {
    const res = await this.fetch('/api/auth/consent', { method: 'POST' });
    return res.json();
  },

  async exportData(telefon) {
    const res = await this.fetch(`/api/brukere/${telefon}/export`);
    return res.json();
  },

  async deleteAccount(telefon) {
    const res = await this.fetch(`/api/brukere/${telefon}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) this.clearSession();
    return data;
  }
};
