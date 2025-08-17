/* ============================================================
    ProviderManager + Chat fix — Professeur Nour
    Pourquoi : #aiProvider et #apiKey doivent vraiment piloter le chat.
    Append-only block — safe to include at the end of the file.
    ============================================================ */
(() => {
   const $ = (s, r=document) => r.querySelector(s);
   const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
   const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

   // ---- UI bootstrap (crée la clé/API + pastille si absente)
   (function ensureControls(){
      const controls = document.querySelector('.controls') || document.body;
      if (!$('#apiKey')) {
         const i = document.createElement('input');
         i.type = 'password'; i.id='apiKey'; i.placeholder='Clé API (si nécessaire)'; i.className='input';
         i.style.marginLeft = '.5rem'; i.style.minWidth = '16rem';
         controls.appendChild(i);
      }
      if (!$('#providerStatus')) {
         const s = document.createElement('span');
         s.id='providerStatus';
         s.style.cssText='margin-left:.5rem; padding:.3rem .6rem; border-radius:9999px; font-size:.85rem;';
         s.textContent = '⏳ test…';
         controls.appendChild(s);
      }
   })();

   // ---- Base URL (fonctionne en file:// → fallback localhost)
   const API_BASE = (() => {
      if (location.protocol.startsWith('http')) return location.origin;
      return 'http://localhost:8000';
   })();

   // ---- Stockage préférences
   const store = {
      get provider(){ return localStorage.getItem('provider') || ($('#aiProvider')?.value || 'internal'); },
      set provider(v){ localStorage.setItem('provider', v); if ($('#aiProvider')) $('#aiProvider').value=v; },
      get apiKey(){ return localStorage.getItem('apiKey') || $('#apiKey')?.value || ''; },
      set apiKey(v){ localStorage.setItem('apiKey', v); if ($('#apiKey')) $('#apiKey').value=v; },
      get model(){ return localStorage.getItem('model') || 'gpt-4o-mini'; },
      set model(v){ localStorage.setItem('model', v); }
   };

   // ---- Helpers HTTP
   async function fetchJSON(url, opts={}, timeout=8000){
      const ctl = new AbortController(); const id=setTimeout(()=>ctl.abort(), timeout);
      try{
         const res = await fetch(url, { ...opts, signal: ctl.signal });
         clearTimeout(id);
         if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
         return await res.json();
      }catch(e){ clearTimeout(id); throw e; }
   }

   async function getHealth(){
      const tries = [`${API_BASE}/health`, `${API_BASE}/api/health`, `${API_BASE}/v1/health`];
      for (const u of tries){
         try { const j = await fetchJSON(u, {}, 3000); if (j && (j.status==='ok' || j.ok===true)) return j; } catch {}
      }
      return null;
   }
   async function healthCheck(){
      const j = await getHealth();
      return !!j;
   }
   async function internalReady(){
      const j = await getHealth();
      return !!(j && j.llm && j.llm.ready === true);
   }

   // ---- Adaptateurs de providers
   const Providers = {
      internal: {
         name:'IA Interne',
         async chat({messages, context}) {
            // Appel strict à l’API interne; tente plusieurs URLs locales
            const prompt = messages.map(m=>`${m.role}: ${m.content}`).join('\n');
            const payload = { prompt, provider: 'internal' };
            if (context && context.trim()) payload.context = context.slice(0, 8000);
            const urls = [
              'http://127.0.0.1:8000/api/chat',
              'http://localhost:8000/api/chat',
              `${API_BASE}/api/chat`
            ];
            for (const url of urls){
               try{
                  const j = await fetchJSON(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 12000);
                  const reply = j.reply || j.output || j.answer || j.text || '';
                  if (reply) return reply;
               }catch(_){ /* try next url */ }
            }
            // Fallback heuristique si l'API interne est indisponible
            const last = messages.filter(m=>m.role==='user').slice(-1)[0]?.content || '';
            const ctx = (context || ($('#textInput')?.value || '')).slice(0, 2000);
            return [
               'Je n’ai pas accès à l’IA interne pour le moment.',
               ctx ? `• Contexte détecté (${Math.min(ctx.length,2000)} car.)` : '• Aucun cours fourni pour le contexte.',
               last ? `• Votre question : « ${last.slice(0,240)} »` : '',
               '• Démarrez le serveur local (Make run) et vérifiez l’état dans Paramètres.',
            ].filter(Boolean).join('\n');
         }
      },
      openai: {
         name:'OpenAI',
         async chat({messages, model, context}) {
            const key = store.apiKey;
            if (!key) throw new Error('Clé API manquante.');
            const mdl = model || store.model || 'gpt-4o-mini';
            const msgs = context ? [{role:'system', content:`Contexte:\n${context}`} , ...messages] : messages;
            // Prefer backend relay to avoid browser CORS
            try{
               if (await healthCheck()){
                  const body = {
                     task: 'chat',
                     prompt: msgs.map(m=>`${m.role}: ${m.content}`).join('\n'),
                     provider: 'openai', model: mdl, api_key: key, max_tokens: 800
                  };
                  const r = await fetchJSON(`${API_BASE}/llm/run`, {
                     method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify(body)
                  });
                  return r.output || '';
               }
            }catch(_){ /* fallback below */ }
            // Direct call (may be blocked by CORS in file://)
            const j = await fetchJSON('https://api.openai.com/v1/chat/completions', {
               method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: mdl, messages: msgs, temperature: 0.3 })
            });
            return j.choices?.[0]?.message?.content || '';
         }
      },
      firecrawl: {
         name:'Firecrawl',
         async chat({messages}) {
            // proxy local /firecrawl/chat; passe la clé via Authorization si fournie
            const key = store.apiKey || localStorage.getItem('firecrawl_api_key') || '';
            const j = await fetchJSON(`${API_BASE}/firecrawl/chat`, {
               method:'POST',
               headers:{'Content-Type':'application/json', ...(key? { 'Authorization': `Bearer ${key}` } : {})},
               body: JSON.stringify({ messages, ...(key? { api_key: key } : {}) })
            });
            return j.answer || j.text || 'Je n’ai pas pu interroger Firecrawl. Vérifiez la clé/API.';
         }
      }
   };

   // ---- Router commun (utilisé partout dans notre app)
   async function __llm_generate({ task='chat', prompt='', question='', sections=[], passages=[], topics=[], count=6 }){
      const providerKey = ($('#aiProvider')?.value) || store.provider || 'internal';
      const provider = Providers[providerKey] || Providers.internal;

      // construction de messages standard
      let messages = [];
      const context = (passages && passages.length) ? passages.map(p=>p.text||'').join('\n---\n').slice(0,8000) : '';
      if (task === 'grounded-chat') {
         messages = [{role:'system', content:'Tu es Professeur Nour, pédagogue, concis et bienveillant. Réponds en français.'}];
         if (context) messages.push({role:'system', content:`Passages: ${context}`});
         messages.push({role:'user', content: question || prompt});
      } else if (task === 'sheets-3views') {
         const txt = sections.map(s=>`# ${s.title}\n${(s.body||'').slice(0,1200)}`).join('\n\n');
         messages = [
            {role:'system', content:'Tu produis 3 vues par section: courte (≤5 bullets), moyenne (1–2 paragraphes avec définitions), longue (≥2 paragraphes structurés). Réponds clair, français.'},
            {role:'user', content: txt }
         ];
      } else if (task === 'make-mcq') {
         const ctx = (passages?.map(p=>p.text).join('\n') || ($('#textInput')?.value||'')).slice(0,3500);
         messages = [
            {role:'system', content:'Génère des QCM FR : 1 seule bonne réponse, 3 distracteurs plausibles, justification brève. Retourne une liste.'},
            {role:'user', content:`Contexte:\n${ctx}\n\nSujets:${(topics||[]).join(', ')}\nNombre:${count}`}
         ];
      } else {
         messages = [{role:'user', content: prompt || question }];
      }

      try {
         // Bonus sécurité: n'autorise pas d'appel OpenAI si non explicitement sélectionné
         if ((providerKey !== 'openai') && provider.name === 'OpenAI') {
            throw new Error('Provider non autorisé (OpenAI non sélectionné).');
         }
         const answer = await provider.chat({ messages, model: store.model, context });
         return { answer };
      } catch (e) {
         console.warn('Provider error:', e);
         const msg = e && e.message ? e.message : String(e || 'Erreur inconnue');
         try{ alert(`Erreur IA (${provider.name}) : ${msg}`); }catch(_){ /* no alert in non-UI env */ }
         return { answer: `Professeur Nour : incident côté ${provider.name}. ${msg}` };
      }
   }

   // Expose global
   window.__llm_generate = __llm_generate;

   // ---- UI : changement provider / clé → mémoriser + tester
   async function updateProviderStatus(){
      const lbl = $('#providerStatus');
      const p = ($('#aiProvider')?.value) || 'internal';
      store.provider = p;
      store.apiKey = $('#apiKey')?.value || store.apiKey;

      if (!lbl) return;
      lbl.textContent = '⏳ test…';
      lbl.style.background = 'transparent'; lbl.style.color = 'inherit'; lbl.style.border = '1px dashed rgba(255,255,255,.2)';

      try {
         if (p === 'internal') {
            const h = await getHealth();
            const ok = !!h, ready = !!(h && h.llm && h.llm.ready===true);
            const def = (h && h.llm && h.llm.default_model) ? ` • modèle: ${h.llm.default_model}` : '';
            lbl.textContent = ready ? ('IA interne • prête' + def) : ok ? 'IA interne • serveur OK, modèle indispo' : 'IA interne • indisponible';
            const good = ready; const warn = ok && !ready;
            lbl.style.background = good ? 'rgba(34,197,94,.15)' : warn ? 'rgba(234,179,8,.15)' : 'rgba(239,68,68,.15)';
            lbl.style.color = good ? '#22c55e' : warn ? '#eab308' : '#ef4444';
            lbl.style.border = 'none';
            } else if (p === 'openai') {
            if (!store.apiKey) throw new Error('Clé manquante');
               // mini ping via backend relay si dispo, sinon direct
               try{
                  if (await healthCheck()){
                     const body = { task:'chat', prompt:'user: ping? réponds "pong".', provider:'openai', model: store.model, api_key: store.apiKey };
                     const r = await fetchJSON(`${API_BASE}/llm/run`, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${store.apiKey}` }, body: JSON.stringify(body) });
                     if (r && r.status==='ok') { lbl.textContent = 'OpenAI • OK'; lbl.style.background='rgba(34,197,94,.15)'; lbl.style.color='#22c55e'; lbl.style.border='none'; return; }
                  }
                  await Providers.openai.chat({ messages:[{role:'user', content:'pong? réponds "pong".'}], model: store.model });
                  lbl.textContent = 'OpenAI • OK'; lbl.style.background='rgba(34,197,94,.15)'; lbl.style.color='#22c55e'; lbl.style.border='none';
               }catch{ throw new Error('Échec appel OpenAI (CORS?) — démarrez le backend ou utilisez le proxy local).'); }
         } else if (p === 'firecrawl') {
            const ok = await fetchJSON(`${API_BASE}/firecrawl/health`, {}, 3000).catch(()=>null);
            lbl.textContent = ok ? 'Firecrawl • OK' : 'Firecrawl indispo';
            lbl.style.background = ok ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)';
            lbl.style.color = ok ? '#22c55e' : '#ef4444';
            lbl.style.border = 'none';
         }
      } catch (e) {
         lbl.textContent = `Erreur provider: ${e.message || e}`;
         lbl.style.background = 'rgba(239,68,68,.15)'; lbl.style.color = '#ef4444'; lbl.style.border='none';
      }
   }

   on($('#aiProvider'), 'change', updateProviderStatus);
   on($('#apiKey'), 'change', updateProviderStatus);
      // En saisissant la clé, on mémorise + tente une connexion immédiate (et auto-bascule vers OpenAI si logique)
   on($('#apiKey'), 'input', () => {
         const v = $('#apiKey').value || '';
         store.apiKey = v;
         // si provider interne indispo, bascule auto vers openai
         (async()=>{
            try{
         const p = ($('#aiProvider')?.value) || store.provider || 'internal';
         const ready = await internalReady();
         if (v && (p==='internal' && !ready)){
                  if ($('#aiProvider')) { $('#aiProvider').value = 'openai'; }
                  store.provider = 'openai';
               }
            }catch(_){ }
            updateProviderStatus();
         })();
      });

   // Démarrage
   updateProviderStatus();

   // ---- Brancher le chat flottant “Professeur Nour”
   (function wireChat(){
      const wrap = $('#nour-chat-messages'), input = $('#nour-chat-input'), send = $('#nour-chat-send');
      if (!wrap || !input || !send) return;

      function add(role, text){
         const m = document.createElement('div');
         m.className = `chat-message ${role==='user'?'user-message':'assistant-message prof-nour'}`;
         m.textContent = text; wrap.appendChild(m); wrap.scrollTop = wrap.scrollHeight;
      }
      async function query(){
         const q = input.value.trim(); if (!q) return;
         add('user', q); input.value='';
         const res = await __llm_generate({ task:'grounded-chat', question:q, passages: [{text: ($('#textInput')?.value||'').slice(0,3000)}] });
   const msg = res.answer && String(res.answer).trim() ? res.answer : 'Aucune réponse du fournisseur sélectionné. Vérifiez l’indicateur d’état ou validez votre clé API.';
      add('assistant', msg);
      }
      send.addEventListener('click', query);
      input.addEventListener('keydown', e=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); query(); } });

      // salutation auto si vide
      if (!wrap.dataset.greeted) {
         add('assistant', 'Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?');
         wrap.dataset.greeted='1';
      }
   })();

      // Settings pane and theme light/dark toggle
      (function wireSettings(){
         const pane = document.getElementById('settings-pane');
         const body = document.getElementById('settings-body');
         const openBtn = document.getElementById('openSettings');
         const closeBtn = document.getElementById('closeSettings');
         const toggleThemeBtn = document.getElementById('toggleTheme');
         function moveControls(){
            try{
               const controls = document.querySelector('header .controls');
               if (!controls || !body) return;
               // Move selected controls into settings body (keep original ordering)
               const list = ['#aiProvider', '#apiKey', '#loadSamplesBtn', '#themeSelect'];
               list.forEach(sel=>{ const el=document.querySelector(sel); if(el) body.insertBefore(el, toggleThemeBtn); });
            }catch(_){ }
         }
         function show(on){ if(pane) pane.classList.toggle('hidden', !on); }
         if (openBtn) openBtn.addEventListener('click', ()=> show(true));
         if (closeBtn) closeBtn.addEventListener('click', ()=> show(false));
         if (toggleThemeBtn){
            toggleThemeBtn.addEventListener('click', ()=>{
               const html = document.documentElement;
               // Always keep dark token; light theme removed
               html.classList.add('theme-dark');
            });
         }
         moveControls();
      })();

})();

/* ============================================================
    QCM text sanitizer — fixes reversed/gibberish French strings
    Applies just-in-time before rendering to avoid UI nonsense.
    Append-only; does not change existing generation pipelines.
    ============================================================ */
(function(){
   function normalizeSpaces(s){ return (s||'').replace(/\s+/g,' ').replace(/\s([:;,.!?])/g,'$1').trim(); }
   function reverse(s){ return (s||'').split('').reverse().join(''); }
   function frScore(s){
      if(!s) return 0;
      const t = s.toLowerCase();
      const tokens = [' le ', ' la ', ' les ', ' des ', ' du ', " l'", " d'", ' est ', ' que ', ' qui ', ' une ', ' un ', ' et '];
      let score = 0; for(const w of tokens){ if(t.includes(w)) score++; }
      // bonus for accents and punctuation placement
      score += (t.match(/[éèêàùçîïôâû]/g)||[]).length>0 ? 1 : 0;
      return score;
   }
   function maybeReverse(s){
      const orig = normalizeSpaces(s);
      const rev = normalizeSpaces(reverse(s));
      return frScore(rev) >= frScore(orig)+2 ? rev : orig;
   }
   function cleanText(s){
      if(!s) return s;
      let out = s.replace(/[\u2026]/g,'…'); // uniform ellipsis
      out = out.replace(/\s*([,;:.!?])\s*/g,'$1 '); // tidy punctuation spacing
      out = out.replace(/\(\s+/g,'(').replace(/\s+\)/g,')');
      out = normalizeSpaces(out);
      // detect and fix reversed
      out = maybeReverse(out);
      return out;
   }
   function sanitizeItem(q){
      if(!q) return q;
      const qq = { ...q };
      if(qq.question) qq.question = cleanText(qq.question);
      if(Array.isArray(qq.options)) qq.options = qq.options.map(cleanText);
      // reindex answer if needed
      if(typeof qq.answer_index !== 'number' && typeof qq.answer === 'string' && Array.isArray(qq.options)){
         const idx = qq.options.findIndex(o=> o && qq.answer && cleanText(o)===cleanText(qq.answer));
         if(idx>=0) qq.answer_index = idx;
      }
      if(typeof qq.answer_index !== 'number') qq.answer_index = 0;
      return qq;
   }

   // Wrap renderQCMs if available to sanitize before rendering
   try{
      const original = (typeof renderQCMs==='function') ? renderQCMs : (window.renderQCMs||null);
      if(original){
         const wrapped = function(){
            try{
               if(typeof state!=='undefined' && Array.isArray(state.qcm)){
                  state.qcm = state.qcm.map(sanitizeItem);
               } else if(window.state && Array.isArray(window.state.qcm)){
                  window.state.qcm = window.state.qcm.map(sanitizeItem);
               }
            }catch(_){ }
            return original.apply(this, arguments);
         };
         if(typeof window!=='undefined') window.renderQCMs = wrapped;
         if(typeof renderQCMs==='function') renderQCMs = wrapped; // best-effort; ignored if const
      }
   }catch(_){ }
})();

// script.js

document.addEventListener('DOMContentLoaded', () => {
   // Theme switcher: apply from saved preference; allow select changes
   try{
      const html=document.documentElement;
   let saved = localStorage.getItem('selected-theme') || 'theme-nour';
   if (saved === 'theme-light') saved = 'theme-nour';
   html.classList.remove('theme-nour','theme-light','theme-studycave');
      html.classList.add(saved);
   // Always enforce dark token (no light mode)
   html.classList.add('theme-dark');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = saved;
   sel?.addEventListener('change', (e)=>{
         const val = e.target.value;
      html.classList.remove('theme-nour','theme-light','theme-studycave');
         html.classList.add(val);
      html.classList.add('theme-dark');
         localStorage.setItem('selected-theme', val);
      });
   }catch(_){ }

   // --- DOM Elements ---
   const dom = {
      // Inputs
      textInput: document.getElementById('textInput'),
      fileInput: document.getElementById('fileInput'),
      dropzone: document.getElementById('dropzone'),
      processBtn: document.getElementById('processBtn'),
        
      // AI & Session Controls
      sessionBtn: document.getElementById('sessionBtn'),
   loadSamplesBtn: document.getElementById('loadSamplesBtn'),
      aiProvider: document.getElementById('aiProvider'),
      apiKey: document.getElementById('apiKey'),

      // Tabs
      tabs: document.querySelector('.tabs'),
      tabContent: document.getElementById('tab-content'),

      // Outputs
      analysisOutput: document.getElementById('analysis-output'),
      sheetOutput: document.getElementById('sheet-output'),
      qcmOutput: document.getElementById('qcm-output'),
      srsOutput: document.getElementById('srs-output'),

      // Chat
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatMessages: document.getElementById('chat-messages'),

      // Socratic
      socraticInput: document.getElementById('socratic-input'),
      socraticSend: document.getElementById('socratic-send'),
   socraticMessages: document.getElementById('socratic-messages'),
   socraticSuggestions: document.getElementById('socratic-suggestions'),

   // Internal chat suggestions
   chatSuggestions: document.getElementById('chat-suggestions'),

      // Modal
      sessionModal: document.getElementById('sessionModal'),
      closeModalBtn: document.querySelector('.close-button'),
      saveSessionBtn: document.getElementById('saveSessionBtn'),
      sessionNameInput: document.getElementById('sessionName'),
      sessionList: document.getElementById('sessionList'),
   };

   // --- Minimal Toast (non-bloquant) ---
   const toastHost = document.createElement('div');
   toastHost.id = 'toast-container';
   toastHost.style.position = 'fixed';
   toastHost.style.right = '16px';
   toastHost.style.bottom = '16px';
   toastHost.style.zIndex = '10000';
   toastHost.setAttribute('role','status');
   toastHost.setAttribute('aria-live','polite');
   document.body.appendChild(toastHost);
   function showToast(msg, type='info', ms=2600){
      const t = document.createElement('div');
      t.style.display = 'flex';
      t.style.alignItems = 'center';
      t.style.gap = '8px';
      t.style.marginTop = '8px';
      t.style.padding = '10px 12px';
      t.style.borderRadius = '10px';
      t.style.boxShadow = '0 6px 20px rgba(20,30,58,.12)';
      t.style.background = type==='success' ? '#ecfdf5' : type==='error' ? '#fef2f2' : type==='warn' ? '#fffbeb' : '#f8fafc';
      t.style.border = '1px solid ' + (type==='success' ? '#a7f3d0' : type==='error' ? '#fecaca' : type==='warn' ? '#fde68a' : '#e5e7f2');
      t.style.color = '#111827';
      const icons = window.__nourToastIcons || {
         success: 'assets/nour-sticker-success.png',
         info: 'assets/nour-sticker-info.png',
         warn: 'assets/nour-sticker-warn.png',
         error: 'assets/nour-sticker-error.png'
      };
      const iconUrl = icons[type] || null;
      if (iconUrl) {
         const img = document.createElement('img');
         img.src = iconUrl; img.alt=''; img.width=22; img.height=22; img.style.borderRadius='50%'; img.style.flex='0 0 22px';
         img.onerror = () => { try { img.remove(); } catch(_){} };
         t.appendChild(img);
      }
      const span = document.createElement('span'); span.textContent = String(msg||''); t.appendChild(span);
      toastHost.appendChild(t);
      setTimeout(()=>{ t.style.transition='opacity .25s, transform .25s'; t.style.opacity='0'; t.style.transform='translateY(6px)'; }, Math.max(0, ms-250));
      setTimeout(()=> t.remove(), ms);
   }
   // Expose toast globally for addons
   window.coachToast = showToast;

   // --- Application State ---
   let state = {
      rawText: '',
      analysis: {
         headings: [],
         pedagogicalBlocks: [],
         keyPhrases: [],
         articles: [],
         themes: []
      },
      studySheet: {},
   qcm: [],
   qcmMode: 'pro', // 'pro' (QCM++) or 'classic'
   qcmCount: 12,
   examMode: false,
      srs: [], // Spaced Repetition System items
      chatHistory: [],
      socraticHistory: [],
      currentSession: 'default',
      // Revision Flow
      sessionPlan: {
         durationMin: 45,
         constraints: { qcmPenalty: 1, timeAvailableMin: 45 },
         goals: { themesTarget: 3, scoreTarget: 80, dueDate: null }
      },
      progress: {
         timeSpentMin: 0,
         scores: { qcmCorrect: 0, qcmTotal: 0 },
         srsStability: 0,
         lastReviewedByTheme: {}
      },
      schedulerQueue: [],
      longSheets: []
   };

   // --- File Handling ---
   function handleCourseInput(content) {
      if (!content) {
         showToast("Le fichier est vide ou illisible.", 'error');
         return;
      }
      // Stocker le contenu pour une utilisation ultérieure par le chat ou d'autres fonctions
      window.currentCourseContent = content;
      dom.textInput.value = content;
      state.rawText = content;
      
      showToast("✅ Cours chargé avec succès. Prêt pour l'analyse.", 'success');
      
      // Ne pas lancer processText() automatiquement. L'utilisateur doit cliquer sur "Lancer".
      // processText();
   }

   dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => handleCourseInput(event.target.result);
      reader.onerror = () => showToast("Erreur de lecture du fichier.", 'error');
      reader.readAsText(file);
   });

   // Drag & drop functionality removed - handled later in the file with better implementation

   // --- Event Listeners ---
   dom.processBtn.addEventListener('click', processText);

   // ---- Provider + API key : test immédiat au changement
   on($('#aiProvider'), 'change', updateProviderStatus);
   on($('#apiKey'), 'change', updateProviderStatus);
      // En saisissant la clé, on mémorise + tente une connexion immédiate (et auto-bascule vers OpenAI si logique)
   on($('#apiKey'), 'input', () => {
         const v = $('#apiKey').value || '';
         store.apiKey = v;
         // si provider interne indispo, bascule auto vers openai
         (async()=>{
            try{
         const p = ($('#aiProvider')?.value) || store.provider || 'internal';
         const ready = await internalReady();
         if (v && (p==='internal' && !ready)){
                  if ($('#aiProvider')) { $('#aiProvider').value = 'openai'; }
                  store.provider = 'openai';
               }
            }catch(_){ }
            updateProviderStatus();
         })();
      });

   // Démarrage
   updateProviderStatus();

   // ---- Brancher le chat flottant “Professeur Nour”
   (function wireChat(){
      const wrap = $('#nour-chat-messages'), input = $('#nour-chat-input'), send = $('#nour-chat-send');
      if (!wrap || !input || !send) return;

      function add(role, text){
         const m = document.createElement('div');
         m.className = `chat-message ${role==='user'?'user-message':'assistant-message prof-nour'}`;
         m.textContent = text; wrap.appendChild(m); wrap.scrollTop = wrap.scrollHeight;
      }
      async function query(){
         const q = input.value.trim(); if (!q) return;
         add('user', q); input.value='';
         const res = await __llm_generate({ task:'grounded-chat', question:q, passages: [{text: ($('#textInput')?.value||'').slice(0,3000)}] });
   const msg = res.answer && String(res.answer).trim() ? res.answer : 'Aucune réponse du fournisseur sélectionné. Vérifiez l’indicateur d’état ou validez votre clé API.';
      add('assistant', msg);
      }
      send.addEventListener('click', query);
      input.addEventListener('keydown', e=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); query(); } });

      // salutation auto si vide
      if (!wrap.dataset.greeted) {
         add('assistant', 'Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?');
         wrap.dataset.greeted='1';
      }
   })();

      // Settings pane and theme light/dark toggle
      (function wireSettings(){
         const pane = document.getElementById('settings-pane');
         const body = document.getElementById('settings-body');
         const openBtn = document.getElementById('openSettings');
         const closeBtn = document.getElementById('closeSettings');
         const toggleThemeBtn = document.getElementById('toggleTheme');
         function moveControls(){
            try{
               const controls = document.querySelector('header .controls');
               if (!controls || !body) return;
               // Move selected controls into settings body (keep original ordering)
               const list = ['#aiProvider', '#apiKey', '#loadSamplesBtn', '#themeSelect'];
               list.forEach(sel=>{ const el=document.querySelector(sel); if(el) body.insertBefore(el, toggleThemeBtn); });
            }catch(_){ }
         }
         function show(on){ if(pane) pane.classList.toggle('hidden', !on); }
         if (openBtn) openBtn.addEventListener('click', ()=> show(true));
         if (closeBtn) closeBtn.addEventListener('click', ()=> show(false));
         if (toggleThemeBtn){
            toggleThemeBtn.addEventListener('click', ()=>{
               const html = document.documentElement;
               // Always keep dark token; light theme removed
               html.classList.add('theme-dark');
            });
         }
         moveControls();
      })();

})();

/* ============================================================
    QCM text sanitizer — fixes reversed/gibberish French strings
    Applies just-in-time before rendering to avoid UI nonsense.
    Append-only; does not change existing generation pipelines.
    ============================================================ */
(function(){
   function normalizeSpaces(s){ return (s||'').replace(/\s+/g,' ').replace(/\s([:;,.!?])/g,'$1').trim(); }
   function reverse(s){ return (s||'').split('').reverse().join(''); }
   function frScore(s){
      if(!s) return 0;
      const t = s.toLowerCase();
      const tokens = [' le ', ' la ', ' les ', ' des ', ' du ', " l'", " d'", ' est ', ' que ', ' qui ', ' une ', ' un ', ' et '];
      let score = 0; for(const w of tokens){ if(t.includes(w)) score++; }
      // bonus for accents and punctuation placement
      score += (t.match(/[éèêàùçîïôâû]/g)||[]).length>0 ? 1 : 0;
      return score;
   }
   function maybeReverse(s){
      const orig = normalizeSpaces(s);
      const rev = normalizeSpaces(reverse(s));
      return frScore(rev) >= frScore(orig)+2 ? rev : orig;
   }
   function cleanText(s){
      if(!s) return s;
      let out = s.replace(/[\u2026]/g,'…'); // uniform ellipsis
      out = out.replace(/\s*([,;:.!?])\s*/g,'$1 '); // tidy punctuation spacing
      out = out.replace(/\(\s+/g,'(').replace(/\s+\)/g,')');
      out = normalizeSpaces(out);
      // detect and fix reversed
      out = maybeReverse(out);
      return out;
   }
   function sanitizeItem(q){
      if(!q) return q;
      const qq = { ...q };
      if(qq.question) qq.question = cleanText(qq.question);
      if(Array.isArray(qq.options)) qq.options = qq.options.map(cleanText);
      // reindex answer if needed
      if(typeof qq.answer_index !== 'number' && typeof qq.answer === 'string' && Array.isArray(qq.options)){
         const idx = qq.options.findIndex(o=> o && qq.answer && cleanText(o)===cleanText(qq.answer));
         if(idx>=0) qq.answer_index = idx;
      }
      if(typeof qq.answer_index !== 'number') qq.answer_index = 0;
      return qq;
   }

   // Wrap renderQCMs if available to sanitize before rendering
   try{
      const original = (typeof renderQCMs==='function') ? renderQCMs : (window.renderQCMs||null);
      if(original){
         const wrapped = function(){
            try{
               if(typeof state!=='undefined' && Array.isArray(state.qcm)){
                  state.qcm = state.qcm.map(sanitizeItem);
               } else if(window.state && Array.isArray(window.state.qcm)){
                  window.state.qcm = window.state.qcm.map(sanitizeItem);
               }
            }catch(_){ }
            return original.apply(this, arguments);
         };
         if(typeof window!=='undefined') window.renderQCMs = wrapped;
         if(typeof renderQCMs==='function') renderQCMs = wrapped; // best-effort; ignored if const
      }
   }catch(_){ }
})();

// script.js

document.addEventListener('DOMContentLoaded', () => {
   // Theme switcher: apply from saved preference; allow select changes
   try{
      const html=document.documentElement;
   let saved = localStorage.getItem('selected-theme') || 'theme-nour';
   if (saved === 'theme-light') saved = 'theme-nour';
   html.classList.remove('theme-nour','theme-light','theme-studycave');
      html.classList.add(saved);
   // Always enforce dark token (no light mode)
   html.classList.add('theme-dark');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = saved;
   sel?.addEventListener('change', (e)=>{
         const val = e.target.value;
      html.classList.remove('theme-nour','theme-light','theme-studycave');
         html.classList.add(val);
      html.classList.add('theme-dark');
         localStorage.setItem('selected-theme', val);
      });
   }catch(_){ }

   // --- DOM Elements ---
   const dom = {
      // Inputs
      textInput: document.getElementById('textInput'),
      fileInput: document.getElementById('fileInput'),
      dropzone: document.getElementById('dropzone'),
      processBtn: document.getElementById('processBtn'),
        
      // AI & Session Controls
      sessionBtn: document.getElementById('sessionBtn'),
   loadSamplesBtn: document.getElementById('loadSamplesBtn'),
      aiProvider: document.getElementById('aiProvider'),
      apiKey: document.getElementById('apiKey'),

      // Tabs
      tabs: document.querySelector('.tabs'),
      tabContent: document.getElementById('tab-content'),

      // Outputs
      analysisOutput: document.getElementById('analysis-output'),
      sheetOutput: document.getElementById('sheet-output'),
      qcmOutput: document.getElementById('qcm-output'),
      srsOutput: document.getElementById('srs-output'),

      // Chat
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatMessages: document.getElementById('chat-messages'),

      // Socratic
      socraticInput: document.getElementById('socratic-input'),
      socraticSend: document.getElementById('socratic-send'),
   socraticMessages: document.getElementById('socratic-messages'),
   socraticSuggestions: document.getElementById('socratic-suggestions'),

   // Internal chat suggestions
   chatSuggestions: document.getElementById('chat-suggestions'),

      // Modal
      sessionModal: document.getElementById('sessionModal'),
      closeModalBtn: document.querySelector('.close-button'),
      saveSessionBtn: document.getElementById('saveSessionBtn'),
      sessionNameInput: document.getElementById('sessionName'),
      sessionList: document.getElementById('sessionList'),
   };

   // --- Minimal Toast (non-bloquant) ---
   const toastHost = document.createElement('div');
   toastHost.id = 'toast-container';
   toastHost.style.position = 'fixed';
   toastHost.style.right = '16px';
   toastHost.style.bottom = '16px';
   toastHost.style.zIndex = '10000';
   toastHost.setAttribute('role','status');
   toastHost.setAttribute('aria-live','polite');
   document.body.appendChild(toastHost);
   function showToast(msg, type='info', ms=2600){
      const t = document.createElement('div');
      t.style.display = 'flex';
      t.style.alignItems = 'center';
      t.style.gap = '8px';
      t.style.marginTop = '8px';
      t.style.padding = '10px 12px';
      t.style.borderRadius = '10px';
      t.style.boxShadow = '0 6px 20px rgba(20,30,58,.12)';
      t.style.background = type==='success' ? '#ecfdf5' : type==='error' ? '#fef2f2' : type==='warn' ? '#fffbeb' : '#f8fafc';
      t.style.border = '1px solid ' + (type==='success' ? '#a7f3d0' : type==='error' ? '#fecaca' : type==='warn' ? '#fde68a' : '#e5e7f2');
      t.style.color = '#111827';
      const icons = window.__nourToastIcons || {
         success: 'assets/nour-sticker-success.png',
         info: 'assets/nour-sticker-info.png',
         warn: 'assets/nour-sticker-warn.png',
         error: 'assets/nour-sticker-error.png'
      };
      const iconUrl = icons[type] || null;
      if (iconUrl) {
         const img = document.createElement('img');
         img.src = iconUrl; img.alt=''; img.width=22; img.height=22; img.style.borderRadius='50%'; img.style.flex='0 0 22px';
         img.onerror = () => { try { img.remove(); } catch(_){} };
         t.appendChild(img);
      }
      const span = document.createElement('span'); span.textContent = String(msg||''); t.appendChild(span);
      toastHost.appendChild(t);
      setTimeout(()=>{ t.style.transition='opacity .25s, transform .25s'; t.style.opacity='0'; t.style.transform='translateY(6px)'; }, Math.max(0, ms-250));
      setTimeout(()=> t.remove(), ms);
   }
   // Expose toast globally for addons
   window.coachToast = showToast;

   // --- Application State ---
   let state = {
      rawText: '',
      analysis: {
         headings: [],
         pedagogicalBlocks: [],
         keyPhrases: [],
         articles: [],
         themes: []
      },
      studySheet: {},
   qcm: [],
   qcmMode: 'pro', // 'pro' (QCM++) or 'classic'
   qcmCount: 12,
   examMode: false,
      srs: [], // Spaced Repetition System items
      chatHistory: [],
      socraticHistory: [],
      currentSession: 'default',
      // Revision Flow
      sessionPlan: {
         durationMin: 45,
         constraints: { qcmPenalty: 1, timeAvailableMin: 45 },
         goals: { themesTarget: 3, scoreTarget: 80, dueDate: null }
      },
      progress: {
         timeSpentMin: 0,
         scores: { qcmCorrect: 0, qcmTotal: 0 },
         srsStability: 0,
         lastReviewedByTheme: {}
      },
      schedulerQueue: [],
      longSheets: []
   };

   // ---- Helpers HTTP
   async function fetchJSON(url, opts={}, timeout=8000){
      const ctl = new AbortController(); const id=setTimeout(()=>ctl.abort(), timeout);
      try{
         const res = await fetch(url, { ...opts, signal: ctl.signal });
         clearTimeout(id);
         if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
         return await res.json();
      }catch(e){ clearTimeout(id); throw e; }
   }

   async function getHealth(){
      const tries = [`${API_BASE}/health`, `${API_BASE}/api/health`, `${API_BASE}/v1/health`];
      for (const u of tries){
         try { const j = await fetchJSON(u, {}, 3000); if (j && (j.status==='ok' || j.ok===true)) return j; } catch {}
      }
      return null;
   }
   async function healthCheck(){
      const j = await getHealth();
      return !!j;
   }
   async function internalReady(){
      const j = await getHealth();
      return !!(j && j.llm && j.llm.ready === true);
   }

   // ---- Adaptateurs de providers
   const Providers = {
      internal: {
         name:'IA Interne',
         async chat({messages, context}) {
            // Appel strict à l’API interne; tente plusieurs URLs locales
            const prompt = messages.map(m=>`${m.role}: ${m.content}`).join('\n');
            const payload = { prompt, provider: 'internal' };
            if (context && context.trim()) payload.context = context.slice(0, 8000);
            const urls = [
              'http://127.0.0.1:8000/api/chat',
              'http://localhost:8000/api/chat',
              `${API_BASE}/api/chat`
            ];
            for (const url of urls){
               try{
                  const j = await fetchJSON(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 12000);
                  const reply = j.reply || j.output || j.answer || j.text || '';
                  if (reply) return reply;
               }catch(_){ /* try next url */ }
            }
            // Fallback heuristique si l'API interne est indisponible
            const last = messages.filter(m=>m.role==='user').slice(-1)[0]?.content || '';
            const ctx = (context || ($('#textInput')?.value || '')).slice(0, 2000);
            return [
               'Je n’ai pas accès à l’IA interne pour le moment.',
               ctx ? `• Contexte détecté (${Math.min(ctx.length,2000)} car.)` : '• Aucun cours fourni pour le contexte.',
               last ? `• Votre question : « ${last.slice(0,240)} »` : '',
               '• Démarrez le serveur local (Make run) et vérifiez l’état dans Paramètres.',
            ].filter(Boolean).join('\n');
         }
      },
      openai: {
         name:'OpenAI',
         async chat({messages, model, context}) {
            const key = store.apiKey;
            if (!key) throw new Error('Clé API manquante.');
            const mdl = model || store.model || 'gpt-4o-mini';
            const msgs = context ? [{role:'system', content:`Contexte:\n${context}`} , ...messages] : messages;
            // Prefer backend relay to avoid browser CORS
            try{
               if (await healthCheck()){
                  const body = {
                     task: 'chat',
                     prompt: msgs.map(m=>`${m.role}: ${m.content}`).join('\n'),
                     provider: 'openai', model: mdl, api_key: key, max_tokens: 800
                  };
                  const r = await fetchJSON(`${API_BASE}/llm/run`, {
                     method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify(body)
                  });
                  return r.output || '';
               }
            }catch(_){ /* fallback below */ }
            // Direct call (may be blocked by CORS in file://)
            const j = await fetchJSON('https://api.openai.com/v1/chat/completions', {
               method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: mdl, messages: msgs, temperature: 0.3 })
            });
            return j.choices?.[0]?.message?.content || '';
         }
      },
      firecrawl: {
         name:'Firecrawl',
         async chat({messages}) {
            // proxy local /firecrawl/chat; passe la clé via Authorization si fournie
            const key = store.apiKey || localStorage.getItem('firecrawl_api_key') || '';
            const j = await fetchJSON(`${API_BASE}/firecrawl/chat`, {
               method:'POST',
               headers:{'Content-Type':'application/json', ...(key? { 'Authorization': `Bearer ${key}` } : {})},
               body: JSON.stringify({ messages, ...(key? { api_key: key } : {}) })
            });
            return j.answer || j.text || 'Je n’ai pas pu interroger Firecrawl. Vérifiez la clé/API.';
         }
      }
   };

   // ---- Router commun (utilisé partout dans notre app)
   async function __llm_generate({ task='chat', prompt='', question='', sections=[], passages=[], topics=[], count=6 }){
      const providerKey = ($('#aiProvider')?.value) || store.provider || 'internal';
      const provider = Providers[providerKey] || Providers.internal;

      // construction de messages standard
      let messages = [];
      const context = (passages && passages.length) ? passages.map(p=>p.text||'').join('\n---\n').slice(0,8000) : '';
      if (task === 'grounded-chat') {
         messages = [{role:'system', content:'Tu es Professeur Nour, pédagogue, concis et bienveillant. Réponds en français.'}];
         if (context) messages.push({role:'system', content:`Passages: ${context}`});
         messages.push({role:'user', content: question || prompt});
      } else if (task === 'sheets-3views') {
         const txt = sections.map(s=>`# ${s.title}\n${(s.body||'').slice(0,1200)}`).join('\n\n');
         messages = [
            {role:'system', content:'Tu produis 3 vues par section: courte (≤5 bullets), moyenne (1–2 paragraphes avec définitions), longue (≥2 paragraphes structurés). Réponds clair, français.'},
            {role:'user', content: txt }
         ];
      } else if (task === 'make-mcq') {
         const ctx = (passages?.map(p=>p.text).join('\n') || ($('#textInput')?.value||'')).slice(0,3500);
         messages = [
            {role:'system', content:'Génère des QCM FR : 1 seule bonne réponse, 3 distracteurs plausibles, justification brève. Retourne une liste.'},
            {role:'user', content:`Contexte:\n${ctx}\n\nSujets:${(topics||[]).join(', ')}\nNombre:${count}`}
         ];
      } else {
         messages = [{role:'user', content: prompt || question }];
      }

      try {
         // Bonus sécurité: n'autorise pas d'appel OpenAI si non explicitement sélectionné
         if ((providerKey !== 'openai') && provider.name === 'OpenAI') {
            throw new Error('Provider non autorisé (OpenAI non sélectionné).');
         }
         const answer = await provider.chat({ messages, model: store.model, context });
         return { answer };
      } catch (e) {
         console.warn('Provider error:', e);
         const msg = e && e.message ? e.message : String(e || 'Erreur inconnue');
         try{ alert(`Erreur IA (${provider.name}) : ${msg}`); }catch(_){ /* no alert in non-UI env */ }
         return { answer: `Professeur Nour : incident côté ${provider.name}. ${msg}` };
      }
   }

   // Expose global
   window.__llm_generate = __llm_generate;

   // ---- UI : changement provider / clé → mémoriser + tester
   async function updateProviderStatus(){
      const lbl = $('#providerStatus');
      const p = ($('#aiProvider')?.value) || 'internal';
      store.provider = p;
      store.apiKey = $('#apiKey')?.value || store.apiKey;

      if (!lbl) return;
      lbl.textContent = '⏳ test…';
      lbl.style.background = 'transparent'; lbl.style.color = 'inherit'; lbl.style.border = '1px dashed rgba(255,255,255,.2)';

      try {
         if (p === 'internal') {
            const h = await getHealth();
            const ok = !!h, ready = !!(h && h.llm && h.llm.ready===true);
            const def = (h && h.llm && h.llm.default_model) ? ` • modèle: ${h.llm.default_model}` : '';
            lbl.textContent = ready ? ('IA interne • prête' + def) : ok ? 'IA interne • serveur OK, modèle indispo' : 'IA interne • indisponible';
            const good = ready; const warn = ok && !ready;
            lbl.style.background = good ? 'rgba(34,197,94,.15)' : warn ? 'rgba(234,179,8,.15)' : 'rgba(239,68,68,.15)';
            lbl.style.color = good ? '#22c55e' : warn ? '#eab308' : '#ef4444';
            lbl.style.border = 'none';
            } else if (p === 'openai') {
            if (!store.apiKey) throw new Error('Clé manquante');
               // mini ping via backend relay si dispo, sinon direct
               try{
                  if (await healthCheck()){
                     const body = { task:'chat', prompt:'user: ping? réponds "pong".', provider:'openai', model: store.model, api_key: store.apiKey };
                     const r = await fetchJSON(`${API_BASE}/llm/run`, { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${store.apiKey}` }, body: JSON.stringify(body) });
                     if (r && r.status==='ok') { lbl.textContent = 'OpenAI • OK'; lbl.style.background='rgba(34,197,94,.15)'; lbl.style.color='#22c55e'; lbl.style.border='none'; return; }
                  }
                  await Providers.openai.chat({ messages:[{role:'user', content:'pong? réponds "pong".'}], model: store.model });
                  lbl.textContent = 'OpenAI • OK'; lbl.style.background='rgba(34,197,94,.15)'; lbl.style.color='#22c55e'; lbl.style.border='none';
               }catch{ throw new Error('Échec appel OpenAI (CORS?) — démarrez le backend ou utilisez le proxy local).'); }
         } else if (p === 'firecrawl') {
            const ok = await fetchJSON(`${API_BASE}/firecrawl/health`, {}, 3000).catch(()=>null);
            lbl.textContent = ok ? 'Firecrawl • OK' : 'Firecrawl indispo';
            lbl.style.background = ok ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)';
            lbl.style.color = ok ? '#22c55e' : '#ef4444';
            lbl.style.border = 'none';
         }
      } catch (e) {
         lbl.textContent = `Erreur provider: ${e.message || e}`;
         lbl.style.background = 'rgba(239,68,68,.15)'; lbl.style.color = '#ef4444'; lbl.style.border='none';
      }
   }

   // Démarrage
   updateProviderStatus();

   // ---- Brancher le chat flottant “Professeur Nour”
   (function wireChat(){
      const wrap = $('#nour-chat-messages'), input = $('#nour-chat-input'), send = $('#nour-chat-send');
      if (!wrap || !input || !send) return;

      function add(role, text){
         const m = document.createElement('div');
         m.className = `chat-message ${role==='user'?'user-message':'assistant-message prof-nour'}`;
         m.textContent = text; wrap.appendChild(m); wrap.scrollTop = wrap.scrollHeight;
      }
      async function query(){
         const q = input.value.trim(); if (!q) return;
         add('user', q); input.value='';
         const res = await __llm_generate({ task:'grounded-chat', question:q, passages: [{text: ($('#textInput')?.value||'').slice(0,3000)}] });
   const msg = res.answer && String(res.answer).trim() ? res.answer : 'Aucune réponse du fournisseur sélectionné. Vérifiez l’indicateur d’état ou validez votre clé API.';
      add('assistant', msg);
      }
      send.addEventListener('click', query);
      input.addEventListener('keydown', e=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); query(); } });

      // salutation auto si vide
      if (!wrap.dataset.greeted) {
         add('assistant', 'Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?');
         wrap.dataset.greeted='1';
      }
   })();

      // Settings pane and theme light/dark toggle
      (function wireSettings(){
         const pane = document.getElementById('settings-pane');
         const body = document.getElementById('settings-body');
         const openBtn = document.getElementById('openSettings');
         const closeBtn = document.getElementById('closeSettings');
         const toggleThemeBtn = document.getElementById('toggleTheme');
         function moveControls(){
            try{
               const controls = document.querySelector('header .controls');
               if (!controls || !body) return;
               // Move selected controls into settings body (keep original ordering)
               const list = ['#aiProvider', '#apiKey', '#loadSamplesBtn', '#themeSelect'];
               list.forEach(sel=>{ const el=document.querySelector(sel); if(el) body.insertBefore(el, toggleThemeBtn); });
            }catch(_){ }
         }
         function show(on){ if(pane) pane.classList.toggle('hidden', !on); }
         if (openBtn) openBtn.addEventListener('click', ()=> show(true));
         if (closeBtn) closeBtn.addEventListener('click', ()=> show(false));
         if (toggleThemeBtn){
            toggleThemeBtn.addEventListener('click', ()=>{
               const html = document.documentElement;
               // Always keep dark token; light theme removed
               html.classList.add('theme-dark');
            });
         }
         moveControls();
      })();

})();

/* ============================================================
    QCM text sanitizer — fixes reversed/gibberish French strings
    Applies just-in-time before rendering to avoid UI nonsense.
    Append-only; does not change existing generation pipelines.
    ============================================================ */
(function(){
   function normalizeSpaces(s){ return (s||'').replace(/\s+/g,' ').replace(/\s([:;,.!?])/g,'$1').trim(); }
   function reverse(s){ return (s||'').split('').reverse().join(''); }
   function frScore(s){
      if(!s) return 0;
      const t = s.toLowerCase();
      const tokens = [' le ', ' la ', ' les ', ' des ', ' du ', " l'", " d'", ' est ', ' que ', ' qui ', ' une ', ' un ', ' et '];
      let score = 0; for(const w of tokens){ if(t.includes(w)) score++; }
      // bonus for accents and punctuation placement
      score += (t.match(/[éèêàùçîïôâû]/g)||[]).length>0 ? 1 : 0;
      return score;
   }
   function maybeReverse(s){
      const orig = normalizeSpaces(s);
      const rev = normalizeSpaces(reverse(s));
      return frScore(rev) >= frScore(orig)+2 ? rev : orig;
   }
   function cleanText(s){
      if(!s) return s;
      let out = s.replace(/[\u2026]/g,'…'); // uniform ellipsis
      out = out.replace(/\s*([,;:.!?])\s*/g,'$1 '); // tidy punctuation spacing
      out = out.replace(/\(\s+/g,'(').replace(/\s+\)/g,')');
      out = normalizeSpaces(out);
      // detect and fix reversed
      out = maybeReverse(out);
      return out;
   }
   function sanitizeItem(q){
      if(!q) return q;
      const qq = { ...q };
      if(qq.question) qq.question = cleanText(qq.question);
      if(Array.isArray(qq.options)) qq.options = qq.options.map(cleanText);
      // reindex answer if needed
      if(typeof qq.answer_index !== 'number' && typeof qq.answer === 'string' && Array.isArray(qq.options)){
         const idx = qq.options.findIndex(o=> o && qq.answer && cleanText(o)===cleanText(qq.answer));
         if(idx>=0) qq.answer_index = idx;
      }
      if(typeof qq.answer_index !== 'number') qq.answer_index = 0;
      return qq;
   }

   // Wrap renderQCMs if available to sanitize before rendering
   try{
      const original = (typeof renderQCMs==='function') ? renderQCMs : (window.renderQCMs||null);
      if(original){
         const wrapped = function(){
            try{
               if(typeof state!=='undefined' && Array.isArray(state.qcm)){
                  state.qcm = state.qcm.map(sanitizeItem);
               } else if(window.state && Array.isArray(window.state.qcm)){
                  window.state.qcm = window.state.qcm.map(sanitizeItem);
               }
            }catch(_){ }
            return original.apply(this, arguments);
         };
         if(typeof window!=='undefined') window.renderQCMs = wrapped;
         if(typeof renderQCMs==='function') renderQCMs = wrapped; // best-effort; ignored if const
      }
   }catch(_){ }
})();

// script.js

document.addEventListener('DOMContentLoaded', () => {
   // Theme switcher: apply from saved preference; allow select changes
   try{
      const html=document.documentElement;
   let saved = localStorage.getItem('selected-theme') || 'theme-nour';
   if (saved === 'theme-light') saved = 'theme-nour';
   html.classList.remove('theme-nour','theme-light','theme-studycave');
      html.classList.add(saved);
   // Always enforce dark token (no light mode)
   html.classList.add('theme-dark');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = saved;
   sel?.addEventListener('change', (e)=>{
         const val = e.target.value;
      html.classList.remove('theme-nour','theme-light','theme-studycave');
         html.classList.add(val);
      html.classList.add('theme-dark');
         localStorage.setItem('selected-theme', val);
      });
   }catch(_){ }

   // --- DOM Elements ---
   const dom = {
      // Inputs
      textInput: document.getElementById('textInput'),
      fileInput: document.getElementById('fileInput'),
      dropzone: document.getElementById('dropzone'),
      processBtn: document.getElementById('processBtn'),
        
      // AI & Session Controls
      sessionBtn: document.getElementById('sessionBtn'),
   loadSamplesBtn: document.getElementById('loadSamplesBtn'),
      aiProvider: document.getElementById('aiProvider'),
      apiKey: document.getElementById('apiKey'),

      // Tabs
      tabs: document.querySelector('.tabs'),
      tabContent: document.getElementById('tab-content'),

      // Outputs
      analysisOutput: document.getElementById('analysis-output'),
      sheetOutput: document.getElementById('sheet-output'),
      qcmOutput: document.getElementById('qcm-output'),
      srsOutput: document.getElementById('srs-output'),

      // Chat
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatMessages: document.getElementById('chat-messages'),

      // Socratic
      socraticInput: document.getElementById('socratic-input'),
      socraticSend: document.getElementById('socratic-send'),
   socraticMessages: document.getElementById('socratic-messages'),
   socraticSuggestions: document.getElementById('socratic-suggestions'),

   // Internal chat suggestions
   chatSuggestions: document.getElementById('chat-suggestions'),

      // Modal
      sessionModal: document.getElementById('sessionModal'),
      closeModalBtn: document.querySelector('.close-button'),
      saveSessionBtn: document.getElementById('saveSessionBtn'),
      sessionNameInput: document.getElementById('sessionName'),
      sessionList: document.getElementById('sessionList'),
   };

   // --- Minimal Toast (non-bloquant) ---
   const toastHost = document.createElement('div');
   toastHost.id = 'toast-container';
   toastHost.style.position = 'fixed';
   toastHost.style.right = '16px';
   toastHost.style.bottom = '16px';
   toastHost.style.zIndex = '10000';
   toastHost.setAttribute('role','status');
   toastHost.setAttribute('aria-live','polite');
   document.body.appendChild(toastHost);
   function showToast(msg, type='info', ms=2600){
      const t = document.createElement('div');
      t.style.display = 'flex';
      t.style.alignItems = 'center';
      t.style.gap = '8px';
      t.style.marginTop = '8px';
      t.style.padding = '10px 12px';
      t.style.borderRadius = '10px';
      t.style.boxShadow = '0 6px 20px rgba(20,30,58,.12)';
      t.style.background = type==='success' ? '#ecfdf5' : type==='error' ? '#fef2f2' : type==='warn' ? '#fffbeb' : '#f8fafc';
      t.style.border = '1px solid ' + (type==='success' ? '#a7f3d0' : type==='error' ? '#fecaca' : type==='warn' ? '#fde68a' : '#e5e7f2');
      t.style.color = '#111827';
      const icons = window.__nourToastIcons || {
         success: 'assets/nour-sticker-success.png',
         info: 'assets/nour-sticker-info.png',
         warn: 'assets/nour-sticker-warn.png',
         error: 'assets/nour-sticker-error.png'
      };
      const iconUrl = icons[type] || null;
      if (iconUrl) {
         const img = document.createElement('img');
         img.src = iconUrl; img.alt=''; img.width=22; img.height=22; img.style.borderRadius='50%'; img.style.flex='0 0 22px';
         img.onerror = () => { try { img.remove(); } catch(_){} };
         t.appendChild(img);
      }
      const span = document.createElement('span'); span.textContent = String(msg||''); t.appendChild(span);
      toastHost.appendChild(t);
      setTimeout(()=>{ t.style.transition='opacity .25s, transform .25s'; t.style.opacity='0'; t.style.transform='translateY(6px)'; }, Math.max(0, ms-250));
      setTimeout(()=> t.remove(), ms);
   }
   // Expose toast globally for addons
   window.coachToast = showToast;

   // --- Application State ---
   let state = {
      rawText: '',
      analysis: {
         headings: [],
         pedagogicalBlocks: [],
         keyPhrases: [],
         articles: [],
         themes: []
      },
      studySheet: {},
   qcm: [],
   qcmMode: 'pro', // 'pro' (QCM++) or 'classic'
   qcmCount: 12,
   examMode: false,
      srs: [], // Spaced Repetition System items
      chatHistory: [],
      socraticHistory: [],
      currentSession: 'default',
      // Revision Flow
      sessionPlan: {
         durationMin: 45,
         constraints: { qcmPenalty: 1, timeAvailableMin: 45 },
         goals: { themesTarget: 3, scoreTarget: 80, dueDate: null }
      },
      progress: {
         timeSpentMin: 0,
         scores: { qcmCorrect: 0, qcmTotal: 0 },
         srsStability: 0,
         lastReviewedByTheme: {}
      },
      schedulerQueue: [],
      longSheets: []
   };

   // ---- Helpers HTTP
   async function fetchJSON(url, opts={}, timeout=8000){
      const ctl = new AbortController(); const id=setTimeout(()=>ctl.abort(), timeout);
      try{
         const res = await fetch(url, { ...opts, signal: ctl.signal });
         clearTimeout(id);
         if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
         return await res.json();
      }catch(e){ clearTimeout(id); throw e; }
   }

   async function getHealth(){
      const tries = [`${API_BASE}/health`, `${API_BASE}/api/health`, `${API_BASE}/v1/health`];
      for (const u of tries){
         try { const j = await fetchJSON(u, {}, 3000); if (j && (j.status==='ok' || j.ok===true)) return j; } catch {}
      }
      return null;
   }
   async function healthCheck(){
      const j = await getHealth();
      return !!j;
   }
   async function internalReady(){
      const j = await getHealth();
      return !!(j && j.llm && j.llm.ready === true);
   }

   // ---- Adaptateurs de providers
   const Providers = {
      internal: {
         name:'IA Interne',
         async chat({messages, context}) {
            // Appel strict à l’API interne; tente plusieurs URLs locales
            const prompt = messages.map(m=>`${m.role}: ${m.content}`).join('\n');
            const payload = { prompt, provider: 'internal' };
            if (context && context.trim()) payload.context = context.slice(0, 8000);
            const urls = [
              'http://127.0.0.1:8000/api/chat',
              'http://localhost:8000/api/chat',
              `${API_BASE}/api/chat`
            ];
            for (const url of urls){
               try{
                  const j = await fetchJSON(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 12000);
                  const reply = j.reply || j.output || j.answer || j.text || '';
                  if (reply) return reply;
               }catch(_){ /* try next url */ }
            }
            // Fallback heuristique si l'API interne est indisponible
            const last = messages.filter(m=>m.role==='user').slice(-1)[0]?.content || '';
            const ctx = (context || ($('#textInput')?.value || '')).slice(0, 2000);
            return [
               'Je n’ai pas accès à l’IA interne pour le moment.',
               ctx ? `• Contexte détecté (${Math.min(ctx.length,2000)} car.)` : '• Aucun cours fourni pour le contexte.',
               last ? `• Votre question : « ${last.slice(0,240)} »` : '',
               '• Démarrez le serveur local (Make run) et vérifiez l’état dans Paramètres.',
            ].filter(Boolean).join('\n');
         }
      },
      openai: {
         name:'OpenAI',
         async chat({messages, model, context}) {
            const key = store.apiKey;
            if (!key) throw new Error('Clé API manquante.');
            const mdl = model || store.model || 'gpt-4o-mini';
            const msgs = context ? [{role:'system', content:`Contexte:\n${context}`} , ...messages] : messages;
            // Prefer backend relay to avoid browser CORS
            try{
               if (await healthCheck()){
                  const body = {
                     task: 'chat',
                     prompt: msgs.map(m=>`${m.role}: ${m.content}`).join('\n'),
                     provider: 'openai', model: mdl, api_key: key, max_tokens: 800
                  };
                  const r = await fetchJSON(`${API_BASE}/llm/run`, {
                     method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify(body)
                  });
                  return r.output || '';
               }
            }catch(_){ /* fallback below */ }
            // Direct call (may be blocked by CORS in file://)
            const j = await fetchJSON('https://api.openai.com/v1/chat/completions', {
               method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: mdl, messages: msgs, temperature: 0.3 })
            });
            return j.choices?.[0]?.message?.content || '';
         }
      },
      firecrawl: {
         name:'Firecrawl',
         async chat({messages}) {
            // proxy local /firecrawl/chat; passe la clé via Authorization si fournie
            const key = store.apiKey || localStorage.getItem('firecrawl_api_key') || '';
            const j = await fetchJSON(`${API_BASE}/firecrawl/chat`, {
               method:'POST',
               headers:{'Content-Type':'application/json', ...(key? { 'Authorization': `Bearer ${key}` } : {})},
               body: JSON.stringify({ messages, ...(key? { api_key: key } : {}) })
            });
            return j.answer || j.text || 'Je n’ai pas pu interroger Firecrawl. Vérifiez la clé/API.';
         }
      }
   };

   // ---- Router commun (utilisé partout dans notre app)
   async function __llm_generate({ task='chat', prompt='', question='', sections=[], passages=[], topics=[], count=6 }){
      const providerKey = ($('#aiProvider')?.value) || store.provider || 'internal';
      const provider = Providers[providerKey] || Providers.internal;

      // construction de messages standard
      let messages = [];
      const context = (passages && passages.length) ? passages.map(p=>p.text||'').join('\n---\n').slice(0,8000) : '';
      if (task === 'grounded-chat') {
         messages = [{role:'system', content:'Tu es Professeur Nour, pédagogue, concis et bienveillant. Réponds en français.'}];
         if (context) messages.push({role:'system', content:`Passages: ${context}`});
         messages.push({role:'user', content: question || prompt});
      } else if (task === 'sheets-3views') {
         const txt = sections.map(s=>`# ${s.title}\n${(s.body||'').slice(0,1200)}`).join('\n\n');
         messages = [
            {role:'system', content:'Tu produis 3 vues par section: courte (≤5 bullets), moyenne (1–2 paragraphes avec définitions), longue (≥2 paragraphes structurés). Réponds clair, français.'},
            {role:'user', content: txt }
         ];
      } else if (task === 'make-mcq') {
         const ctx = (passages?.map(p=>p.text).join('\n') || ($('#textInput')?.value||'')).slice(0,3500);
         messages = [
            {role:'system', content:'Génère des QCM FR : 1 seule bonne réponse, 3 distracteurs plausibles, justification brève. Retourne une liste.'},
            {role:'user', content:`Contexte:\n${ctx}\n\nSujets:${(topics||[]).join(', ')}\nNombre:${count}`}
         ];
      } else {
         messages = [{role:'user', content: prompt || question }];
      }

      try {
         // Bonus sécurité: n'autorise pas d'appel OpenAI si non explicitement sélectionné
         if ((providerKey !== 'openai') && provider.name === 'OpenAI') {
            throw new Error('Provider non autorisé (OpenAI non sélectionné).');
         }
         const answer = await provider.chat({ messages, model: store.model, context });
         return { answer };
      } catch (e) {
         console.warn('Provider error:', e);
         const msg = e && e.message ? e.message : String(e || 'Erreur inconnue');
         try{ alert(`Erreur IA (${provider.name}) : ${msg}`); }catch(_){ /* no alert in non-UI env */ }
         return { answer: `Professeur Nour : incident côté ${provider.name}. ${msg}` };
      }
   }

   // Build smart suggestion chips for Socratic and internal chats
   function buildSuggestionSeeds(max = 8){
      const themes = state.analysis?.themes || [];
      const topThemes = themes.slice(0, 6).map(t => t.title).filter(Boolean);
      const topKeys = uniq(themes.flatMap(t=> (t.keyPhrases||[]))).slice(0, 10);
      const starters = [
         'Peux-tu reformuler la définition ?',
         'Quelles sont les exceptions ?',
         'Donne un exemple concret.',
         'Quelle est la règle générale ?',
         'Quelle jurisprudence est liée ?',
         'Quels sont les pièges fréquents ?',
      ];
      const out = [];
      for(const th of topThemes){ out.push(`Explique ${th} en questions.`); if(out.length>=max) break; }
      for(const k of topKeys){ if(out.length>=max) break; out.push(`Qu’implique « ${k} » ?`); }
      for(const s of starters){ if(out.length>=max) break; out.push(s); }
      return uniq(out).slice(0, max);
   }
   function renderSocraticSuggestions(){
      const host = dom.socraticSuggestions; if(!host) return;
      const items = buildSuggestionSeeds(8);
      host.innerHTML = items.map(q => `<button class="chip" data-suggest="socratic">${escapeHTML(q)}</button>`).join('');
   }
   function renderChatSuggestions(){
      const host = dom.chatSuggestions; if(!host) return;
      const items = buildSuggestionSeeds(6);
      host.innerHTML = items.map(q => `<button class="chip" data-suggest="chat">${escapeHTML(q)}</button>`).join('');
   }

   // --- Event Handlers ---

   // Tabs with WAI-ARIA sync + keyboard
   function activateTab(btn){
      if(!btn || !btn.dataset.tab) return;
      const tabId = btn.dataset.tab;
      dom.tabs.querySelectorAll('.tab-link').forEach(b=>{
         const isActive = b===btn;
         b.classList.toggle('active', isActive);
         b.setAttribute('aria-selected', isActive? 'true':'false');
         b.setAttribute('tabindex', isActive? '0':'-1');
      });
      dom.tabContent.querySelectorAll('.tab-pane').forEach(p=>{
         const show = p.id===tabId;
         p.classList.toggle('active', show);
         p.setAttribute('aria-hidden', show? 'false':'true');
      });
      // Show input card only on Analyse tab for clarity
      try {
         const inputCard = document.getElementById('input-card');
         if (inputCard) inputCard.style.display = (tabId==='analyse') ? '' : 'none';
      } catch(_){}
      btn.focus();
   }
   dom.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-link');
      if (!btn) return;
      activateTab(btn);
      // Special case: Cartes tab should toggle the injected flashcards pane id
      if(btn.dataset.tab==='flashcards-pane'){
         // Ensure pane exists and is active
         const pane=document.getElementById('flashcards-pane');
         if(!pane){ /* mounted later by addon */ }
      }
   });
   dom.tabs.addEventListener('keydown', (e)=>{
      const current = e.target.closest('.tab-link');
      if(!current) return;
      const tabs = [...dom.tabs.querySelectorAll('.tab-link')];
      const i = tabs.indexOf(current);
      if(e.key==='ArrowRight' || e.key==='ArrowDown'){ e.preventDefault(); activateTab(tabs[(i+1)%tabs.length]); }
      else if(e.key==='ArrowLeft' || e.key==='ArrowUp'){ e.preventDefault(); activateTab(tabs[(i-1+tabs.length)%tabs.length]); }
      else if(e.key==='Home'){ e.preventDefault(); activateTab(tabs[0]); }
      else if(e.key==='End'){ e.preventDefault(); activateTab(tabs[tabs.length-1]); }
   });

   // Process button: route by provider
   dom.processBtn.addEventListener('click', async () => {
      const prov = (dom.aiProvider && dom.aiProvider.value) || 'internal';
   // lightweight skeleton placeholders
   if(dom.analysisOutput){ dom.analysisOutput.innerHTML = '<div class="skeleton h16 w60"></div><div class="skeleton h12 w90" style="margin-top:8px"></div><div class="skeleton h12 w80" style="margin-top:6px"></div>'; }
   if(dom.sheetOutput){ dom.sheetOutput.innerHTML = '<div class="skeleton h16 w40"></div><div class="skeleton h12 w70" style="margin-top:8px"></div>'; }
      if (prov === 'firecrawl') {
         try { await analyseCoursFirecrawl(); } catch (e) { showToast('Firecrawl: ' + (e?.message||e), 'error'); }
      } else {
         processText();
      }
   });

      // Bind sample loader
      if(dom.loadSamplesBtn){ dom.loadSamplesBtn.addEventListener('click', loadSamplesAndRender); }

   // File Handling - Add safety checks and DOM ready wrapper
   document.addEventListener('DOMContentLoaded', function() {
      const dropzone = document.getElementById('dropzone');
      const fileInput = document.getElementById('fileInput');
      
      if (dropzone && fileInput) {
         dropzone.addEventListener('click', () => fileInput.click());
         dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
         });
         dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
         dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            handleFile(e.dataTransfer.files[0]);
         });
         
         fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
      }
   });
   
   // Fallback for cases where DOMContentLoaded already fired
   setTimeout(() => {
      const dropzone = document.getElementById('dropzone');
      const fileInput = document.getElementById('fileInput');
      
      if (dropzone && fileInput && !dropzone.hasAttribute('data-listeners-attached')) {
         dropzone.setAttribute('data-listeners-attached', 'true');
         dropzone.addEventListener('click', () => fileInput.click());
         dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
         });
         dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
         dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            handleFile(e.dataTransfer.files[0]);
         });
         
         fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
      }
   }, 100);

   // Also allow dragging files onto the Prof. NOUR logo in the header
   const logo = document.getElementById('logo-drop');
   if (logo) {
      logo.addEventListener('dragover', (e) => { e.preventDefault(); logo.classList.add('dropover'); });
      logo.addEventListener('dragleave', () => logo.classList.remove('dropover'));
      logo.addEventListener('drop', (e) => {
         e.preventDefault(); logo.classList.remove('dropover');
         const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f);
      });
      logo.addEventListener('click', () => dom.fileInput && dom.fileInput.click());
   }

   // Debounced trigger to process text right after file load
   let _fileProcessTimer = null;
   function _triggerProcessSoon(){
      if(_fileProcessTimer) clearTimeout(_fileProcessTimer);
      _fileProcessTimer = setTimeout(()=>{
         try{ processText(); }catch(_){ /* noop */ }
      }, 120);
   }

   function handleFile(file) {
      if (!file) return;
      const name = (file.name||'').toLowerCase();
      const reader = new FileReader();
      if (name.endsWith('.docx')) {
         reader.onload = (e) => {
            mammoth.extractRawText({ arrayBuffer: e.target.result })
               .then(result => {
                  dom.textInput.value = result.value;
                  _triggerProcessSoon();
               })
               .catch(err => showToast("Erreur de lecture du .docx", 'error'));
         };
         reader.readAsArrayBuffer(file);
      } else if (name.endsWith('.txt') || name.endsWith('.md')) {
         reader.onload = (e) => {
            dom.textInput.value = e.target.result;
            _triggerProcessSoon();
         };
         reader.readAsText(file);
      } else if (name.endsWith('.pdf') || name.endsWith('.doc') || name.endsWith('.ppt') || name.endsWith('.pptx')) {
         showToast('Ce format sera bientôt pris en charge. Convertissez en .txt ou .docx pour l’instant.', 'warn');
      } else {
         showToast('Format non pris en charge. Utilisez .txt, .md ou .docx.', 'warn');
      }
   }

   // Enable drag & drop directly inside the Parcours pane: paste to #textInput and regenerate
   (function enableParcoursDrop(){
      const pane = document.getElementById('parcours');
      if(!pane) return;
      const prevent=(e)=>{ e.preventDefault(); e.stopPropagation(); };
      ['dragenter','dragover','dragleave','drop'].forEach(ev=> pane.addEventListener(ev, prevent));
      pane.addEventListener('drop', (e)=>{
         const f = e.dataTransfer?.files?.[0];
         if (f) { handleFile(f); return; }
         // If text was dropped, use it directly
         const txt = e.dataTransfer?.getData('text/plain');
         if (txt && txt.trim()){
            dom.textInput.value = txt.trim();
            // Store course content but don't auto-generate parcours
            // User must manually click "Générer le parcours" to create guided tour
            showToast('Cours chargé. Cliquez sur "Générer le parcours" pour commencer.', 'success');
         }
      });
   })();

   // Grounded chat util: call /api/chat with context from #textInput
   window.nourGroundedChat = async function(prompt){
      const context = (dom.textInput?.value || '').slice(0, 8000);
      try{
         const urls = [
            'http://127.0.0.1:8000/api/chat',
            'http://localhost:8000/api/chat',
            `${location.protocol.startsWith('http')? location.origin : 'http://localhost:8000'}/api/chat`
         ];
         for (const u of urls){
            try{
               const r = await fetch(u, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, context }) });
               if(r.ok){ const j = await r.json(); if(j.reply) return j.reply; }
            }catch(_){ }
         }
         return '';
      }catch(_){ return ''; }
   }

   // QCM Interaction
   dom.qcmOutput.addEventListener('change', (e) => {
      // Toolbar interactions
      if(e.target.id==='qcmMode'){
         state.qcmMode = e.target.value==='classic' ? 'classic' : 'pro';
         regenerateQCMs();
         renderQCMs();
         return;
      }
      if(e.target.id==='qcmCount'){
         state.qcmCount = Number(e.target.value)||10;
         regenerateQCMs();
         renderQCMs();
         return;
      }
      if(e.target.id==='qcmView'){
         state.examMode = e.target.value==='exam';
         // Recompute option order deterministically when switching view
         for (let i=0;i<state.qcm.length;i++){
            const q = state.qcm[i];
            const seed = hashString(String(q.question||'') + '|' + String(q.answer||''));
            q._order = state.examMode ? seededShuffle(q.options, seed) : shuffleArray([...q.options]);
         }
         renderQCMs();
         return;
      }
      // Question interactions
   if (e.target.name && e.target.name.startsWith('qcm')) {
         const itemDiv = e.target.closest('.qcm-item');
         const index = parseInt(itemDiv.dataset.index);
         const q = state.qcm[index];
         if(!q || !Array.isArray(q.options) || !q.options.length){ return; }
         const feedbackDiv = itemDiv.querySelector('.feedback');
         const displayed = (q._order && q._order.length ? q._order : q.options);

         // Multi-answer support when q.answers array exists (checkbox UI)
         if (Array.isArray(q.answers) && q.answers.length) {
            const checked = Array.from(itemDiv.querySelectorAll('input[type="checkbox"]:checked')).map(i=>i.value);
            const target = (q.answers || []).filter(a => displayed.includes(a));
            const setEq = (a,b)=> a.length===b.length && a.every(x=>b.includes(x));
            const correct = setEq(checked.sort(), target.slice().sort());
            if (correct) {
               q.answered = 'correct';
               feedbackDiv.textContent = 'Correct !';
               feedbackDiv.className = 'feedback correct';
               itemDiv.classList.remove('is-incorrect');
               itemDiv.classList.add('is-correct');
               try{ (window.coachToast||showToast)('Bien joué !','success'); }catch(_){ }
            } else {
               q.answered = 'incorrect';
               const miss = target.filter(a=>!checked.includes(a));
               const extra = checked.filter(a=>!target.includes(a));
               const parts = [];
               if (miss.length) parts.push(`Manquantes: ${miss.join(', ')}`);
               if (extra.length) parts.push(`En trop: ${extra.join(', ')}`);
               feedbackDiv.textContent = `Partiel. ${parts.join(' | ')}`;
               feedbackDiv.className = 'feedback incorrect';
               itemDiv.classList.remove('is-correct');
               itemDiv.classList.add('is-incorrect');
               addToSRS({ type: 'qcm', data: q, reason: 'Réponse partielle/incorrecte' });
               try{ (window.coachToast||showToast)('Presque, retente ta chance.','warn'); }catch(_){ }
            }
            return;
         }

         // Single-answer (radio) behavior
         const selectedValue = e.target.value;
         const selectedIdx = displayed.findIndex(v => v === selectedValue);
         const trueIdx = q.options.findIndex(v => v === q.answer);
         const isCorrect = (selectedIdx >= 0) && (displayed[selectedIdx] === q.answer) && (trueIdx >= 0);
         if (isCorrect) {
               q.answered = 'correct';
               feedbackDiv.textContent = "Correct !";
               feedbackDiv.className = 'feedback correct';
               itemDiv.classList.remove('is-incorrect');
               itemDiv.classList.add('is-correct');
               try{ (window.coachToast||showToast)('Bien joué !','success'); }catch(_){ }
            } else {
               q.answered = 'incorrect';
               feedbackDiv.textContent = `Incorrect. La bonne réponse était : ${q.answer}`;
               feedbackDiv.className = 'feedback incorrect';
               itemDiv.classList.remove('is-correct');
               itemDiv.classList.add('is-incorrect');
               addToSRS({ type: 'qcm', data: q, reason: 'Réponse incorrecte' });
               try{ (window.coachToast||showToast)('On révise et on y retourne ✨','warn'); }catch(_){ }
            }
      }
   });
   // Toolbar button (click)
   dom.qcmOutput.addEventListener('click', (e)=>{
      if(e.target && e.target.id==='qcmRegen'){
         regenerateQCMs();
         renderQCMs();
      }
      if(e.target && e.target.id==='qcmReset'){
         // Clear selections and feedback, keep same questions
         state.qcm.forEach(q=>{ q.answered = null; });
         const items = dom.qcmOutput.querySelectorAll('.qcm-item');
         items.forEach(item=>{
            item.querySelectorAll('input[type="radio"]').forEach(r=>{ r.checked=false; });
            item.querySelectorAll('input[type="checkbox"]').forEach(c=>{ c.checked=false; });
            const fb=item.querySelector('.feedback'); if(fb){ fb.textContent=''; fb.className='feedback'; }
         });
      }
      const btn = e.target.closest('button');
      if(btn && btn.dataset.action==='toggle-proof'){
         const card = btn.closest('.qcm-item');
         const proof = card.querySelector('.proof-text');
         if(proof){ const hidden = proof.classList.toggle('hidden'); btn.textContent = hidden? 'Voir la preuve':'Masquer la preuve'; }
      }
      if(btn && btn.dataset.action==='flag'){
         const card = btn.closest('.qcm-item');
         const index = parseInt(card.dataset.index);
         const q = state.qcm[index];
         q.flagged = true; q.meta = q.meta || {}; q.meta.reliability = 'red';
         addToSRS({ type: 'qcm', data: q, reason: 'Signalé ambigu' });
         btn.disabled = true; btn.textContent = 'Signalé';
         // Re-render reliability badge
         renderQCMs();
      }
   });

   // Suggestion chip clicks for both chats
   document.addEventListener('click', (e)=>{
      const chip = e.target.closest('button.chip'); if(!chip) return;
      const txt = chip.textContent.trim(); const ctx = chip.dataset.suggest;
      if(ctx==='socratic'){ dom.socraticInput.value = txt; handleSocraticChat(); }
      else if(ctx==='chat'){ dom.chatInput.value = txt; handleInternalChat(); }
   });

   // --- Heuristics & helpers for QCM reliability ---
   function escapeHTML(s){ return (s||'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
   function tokenize(str){ return (str||'').toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean); }
   function jaccard(a,b){ const A=new Set(tokenize(a)), B=new Set(tokenize(b)); if(!A.size && !B.size) return 0; let inter=0; for(const x of A) if(B.has(x)) inter++; return inter/(A.size+B.size-inter); }
   function antiOverlapOptions(options, answer){
      const out=[]; const seen=new Set();
      for(const opt of options){
         const o=String(opt).trim(); if(!o) continue; if(seen.has(o)) continue; if(answer && (o===answer)) { out.push(o); seen.add(o); continue; }
         if(answer){ const sim=jaccard(o, answer); if(sim>0.7 || o.includes(answer) || answer.includes(o)) continue; }
         // avoid near-duplicates with existing
         let dupe=false; for(const e of out){ if(jaccard(e,o)>0.8) { dupe=true; break; } }
         if(!dupe){ out.push(o); seen.add(o); }
      }
      // Ensure the correct answer exists
      if(answer && !out.includes(answer)) out.unshift(answer);
      // Normalize to exactly 4 options: cap then pad with safe generic distractors
      let arr = out.slice(0,4);
      const fillers = [
         'Proposition incorrecte',
         'Réponse incomplète',
         'Information non pertinente',
         'Hypothèse plausible mais fausse'
      ];
      while(arr.length < 4){
         const f = fillers[arr.length % fillers.length];
         if(!arr.includes(f) && f !== answer) arr.push(f); else arr.push(f+" ");
      }
      return arr;
   }
   function bestSentencesPool(analysis){
      const pool=[]; (analysis.themes||[]).forEach(t=> (t.sentences||[]).forEach(s=> pool.push(s)) );
      return pool.length? pool : (state.rawText.split(/\n+/).filter(x=>x.length>30));
   }
   function findBestProofSentence(q, analysis){
      const pool=bestSentencesPool(analysis); const key = q.answer || q.question || '';
      let best='', bs=0; for(const s of pool){ const sc = Math.max(jaccard(s, key), jaccard(s, q.question||'')); if(sc>bs){ bs=sc; best=s; } }
      return { text: best, score: bs };
   }
   function difficultyFrom(q, proof){
      const L=(q.question||'').length + (q.answer||'').length; const lenScore = L>220? 0.6 : L>140? 0.4 : 0.2;
      const sims = (q.options||[]).filter(o=>o!==q.answer).map(o=> jaccard(o, proof.text||''));
      const avg = sims.length? sims.reduce((a,b)=>a+b,0)/sims.length : 0;
      const score = lenScore + avg; // 0..~1
      return score>0.55? 'hard' : score>0.3? 'medium' : 'easy';
   }
   function reliabilityFrom(q, proof){
      const scores = (q.options||[]).map(o=> ({o, s: jaccard(o, proof.text||'')})).sort((a,b)=>b.s-a.s);
      const idx = scores.findIndex(x=>x.o===q.answer);
      const top = scores[0]?.s||0, ans = (scores[idx]?.s)||0, second = scores[idx===0?1:0]?.s||0, gap = Math.max(0, ans - second);
      const level = (ans>=0.7 && gap>=0.25)? 'green' : (ans>=0.5 && gap>=0.1)? 'orange' : 'red';
      return { level, scores };
   }
   function applyQCMHeuristics(q, analysis){
      // Normalize and filter options
      q.options = antiOverlapOptions(q.options||[], q.answer||'');
      // Proof
      const proof = findBestProofSentence(q, analysis);
      // Difficulty & reliability
      const diff = difficultyFrom(q, proof);
      const rel = reliabilityFrom(q, proof);
      q.meta = Object.assign({}, q.meta||{}, { difficulty: diff, reliability: rel.level, proof: proof.text, support: rel.scores });
      return q;
   }

   // Confidence Rating & Fiche toggles
   dom.sheetOutput.addEventListener('click', (e) => {
      if (e.target.tagName === 'SPAN' && e.target.dataset.value) {
         const ratingDiv = e.target.parentElement;
         const index = parseInt(ratingDiv.dataset.index);
         const value = parseInt(e.target.dataset.value);
         state.studySheet.children[index].confidence = value;

         // Update stars UI
         for (let i = 0; i < 5; i++) {
            ratingDiv.children[i+1].style.color = i < value ? 'var(--primary-color)' : '#555';
         }

         if (value < 3) {
            addToSRS({ type: 'sheet', data: state.studySheet.children[index], reason: `Confiance faible (${value}/5)` });
         }
      }
   // Card view switcher
   const viewBtn = e.target.closest('[data-action="set-view"]');
   if(viewBtn){
      const card = viewBtn.closest('.sheet-card'); const view = viewBtn.dataset.view || 'essentiel';
      const toolbarSel = document.getElementById('sheetDetail'); if(toolbarSel && ['essentiel','court','long'].includes(view)) toolbarSel.value=view;
      // Use helper defined in renderStudySheet scope if available
      try{ (function(){ const cardEl=card; const v=view; const views = cardEl.querySelectorAll('.summary .view'); views.forEach(x=>x.classList.add('hidden')); const tgt = cardEl.querySelector(`.summary .v-${v}`); if(tgt) tgt.classList.remove('hidden'); cardEl.dataset.view=v; cardEl.querySelectorAll('.view-toggle [data-action="set-view"]').forEach(b=> b.classList.toggle('selected', b.dataset.view===v)); })(); }catch(_){ }
      return;
   }
   if (e.target.classList.contains('toggle')) {
      const card = e.target.closest('.sheet-card');
         const action = e.target.dataset.action;
         if(action === 'toggle-section'){
            const sec = e.target.dataset.section;
            const box = card.querySelector(`.section-${sec}`);
            if(box){ const hidden = box.classList.toggle('hidden'); e.target.textContent = hidden? e.target.textContent.replace('Masquer','Afficher') : e.target.textContent.replace('Définitions','Masquer définitions').replace('Règles/Exceptions','Masquer règles').replace('Exemples','Masquer exemples').replace('Références','Masquer références').replace('Questions types','Masquer questions'); }
            return;
         }
         if (action === 'toggle-long') {
            const fullLong = card.querySelector('.full-long');
            if (fullLong) {
               const hidden = fullLong.classList.toggle('hidden');
               e.target.textContent = hidden ? 'Fiche longue' : 'Fermer';
            }
            return;
         }
         if (action === 'toggle') {
            const full = card.querySelector('.full:not(.full-long)');
            if (full) {
               const hidden = full.classList.toggle('hidden');
               e.target.textContent = hidden ? 'Voir plus' : 'Voir moins';
            }
         }
      }
   });

   // Chat
   dom.chatSend.addEventListener('click', handleInternalChat);
   dom.chatInput.addEventListener('keyup', (e) => e.key === 'Enter' && handleInternalChat());

   function handleInternalChat() {
      const query = dom.chatInput.value.trim();
      if (!query) return;
      state.chatHistory.push({ role: 'user', content: query });
      dom.chatInput.value = '';
      renderChat();

      // Simple internal AI logic
      let response = getInternalResponse(query);
      if (typeof window.__formatAssistantReply === 'function') {
         try { response = window.__formatAssistantReply(response); } catch(_) {}
      }
      state.chatHistory.push({ role: 'assistant', content: response });
      renderChat();
   }

   // --- Firecrawl Local RAG integration ---
   async function analyseCoursFirecrawl(){
   const texte = dom.textInput.value.trim();
   if(!texte){ showToast('Veuillez fournir un texte de cours.', 'warn'); return; }
   if(dom.analysisOutput){ dom.analysisOutput.innerHTML = '<div class="skeleton h16 w60"></div><div class="skeleton h12 w90" style="margin-top:8px"></div><div class="skeleton h12 w80" style="margin-top:6px"></div>'; }
   if(dom.sheetOutput){ dom.sheetOutput.innerHTML = '<div class="skeleton h16 w30"></div><div class="skeleton h12 w70" style="margin-top:8px"></div>'; }
      // Build payload using a fake URL (we pass content separately if your backend supports it)
      const payload = {
         urls: ["https://cours.local/" + Date.now()],
         prompt: "Agis comme un professeur expérimenté. Résume ce texte en trois sections pédagogiques : Notions clés à comprendre, Définitions essentielles, Questions à poser à l’élève pour vérifier sa compréhension.",
         schema: {
            type: 'object',
            properties: {
               notions_cles: { type: 'array', items: { type: 'string' }},
               definitions: { type: 'array', items: { type: 'string' }},
               questions: { type: 'array', items: { type: 'string' }}
            },
            required: ['notions_cles','definitions','questions']
         },
         // Optionally include raw text if your Firecrawl fork supports it
         text: texte
      };
      // Some RAG servers use different endpoints; try a few fallbacks before degrading
      async function tryMany() {
         const targets = [
            { url: 'http://localhost:3002/v1/extract', method: 'POST', body: JSON.stringify(payload) },
            { url: 'http://localhost:3002/api/extract', method: 'POST', body: JSON.stringify(payload) },
            // Fallback to local FastAPI helper if running
            { url: 'http://localhost:8000/v1/extract', method: 'POST', body: JSON.stringify({ ...payload, schema_: payload.schema }) },
         ];
         for (const t of targets) {
            try {
               const r = await fetch(t.url, { method: t.method, headers: { 'Content-Type': 'application/json' }, body: t.body });
               if (r.ok) return await r.json();
               // If method not allowed or not found, continue to next target
               if ([404,405].includes(r.status)) continue;
               // Other HTTP errors: read message and try next
               await r.text();
            } catch(_) { /* try next */ }
         }
         throw new Error('RAG indisponible (toutes les tentatives ont échoué)');
      }
      let data;
      try{
         const result = await tryMany();
         data = result?.data || result || {};
      }catch(err){
         // Fallback automatique vers IA Interne si tous les endpoints RAG échouent
         try { (window.coachToast||showToast)('RAG indisponible, bascule vers IA interne…','warn'); } catch(_) {}
         processText();
         return;
      }
      // Optionally keep the summary in memory for future use
   state.ragSummary = {
         notions: data.notions_cles || [],
         definitions: data.definitions || [],
         questions: data.questions || []
      };
      // Also run local analysis (without re-rendering the sheet) for QCM/SRS/Chats/Parcours
      state.rawText = texte;
      state.analysis.headings = splitByHeadings(texte);
      state.analysis.pedagogicalBlocks = extractPedagogicalBlocks(texte);
      state.analysis.articles = extractArticles ? extractArticles(texte) : [];
      state.analysis.keyPhrases = extractKeyPhrases(texte);
      state.analysis.themes = makeThemes ? makeThemes(texte) : (state.analysis.headings || []);
   renderAnalysis();

   // Prepare study data in state and render standard fiches UI
      state.studySheet = generateStudySheet(state.analysis.themes || state.analysis.headings || []);
      state.longSheets = generateLongSheets(
         state.analysis.themes || [],
         state.analysis.pedagogicalBlocks || [],
         state.analysis.articles || [],
         state.analysis.keyPhrases || []
      );
   renderStudySheet();

      // QCM and SRS
      regenerateQCMs();
      renderQCMs();
      state.srs = [];
      renderSRS();

      // Reset chats
      state.chatHistory = [];
      state.socraticHistory = [];
      renderChat();
      renderSocraticChat();

      // Attach/start guided flow if available (matching processText behavior)
      try {
         if (window.RevisionFlow && state.analysis && Array.isArray(state.analysis.themes)) {
            const external = {
               themes: (state.analysis.themes || []).map((t, i) => ({
                  title: t.title,
                  raw: t.raw,
                  summaryLong: state.studySheet?.children?.[i]?.summary || '',
                  summaryShort: (t.sentences || []).slice(0, 2).join(' '),
                  keywords: t.keyPhrases || [],
                  refs: t.references || [],
                  blocks: (state.analysis.pedagogicalBlocks || []).filter(b => (t.raw||'').includes(b.content))
               }))
            };
            if (typeof window.RevisionFlow.start === 'function') {
               window.RevisionFlow.start(external, { duration: state.sessionPlan?.durationMin || 60, lowConfidence: new Set(), spaced: [] });
            }
         }
      } catch (e) { /* no-op */ }
   }

   function getInternalResponse(query) {
      // Improved hybrid retrieval: TF-IDF + keyword boosting + sheet summaries
      const q = normalize(query);
      const tokens = q.split(/\s+/).filter(Boolean);
      const themes = state.analysis.themes || [];
      const docs = [];
      themes.forEach((t, ti) => {
         (t.sentences||[]).forEach(s => docs.push({ theme: t.title, text: s, norm: normalize(s), w: 1.0 }));
         const sum = state.studySheet?.children?.[ti]?.summary || '';
         if(sum) docs.push({ theme: t.title, text: sum, norm: normalize(sum), w: 1.3 });
      });
      if (docs.length === 0) {
         const found = state.analysis.headings.find(h => h.content.toLowerCase().includes(query.toLowerCase()));
         return found ? `Voici ce que j'ai trouvé concernant "${query}":\n\n${found.content.substring(0, 300)}...` : "Désolé, je n'ai pas trouvé d'information pertinente dans le document. Essayez de reformuler.";
      }
      const N = docs.length;
      const df = Object.create(null);
      tokens.forEach(tok => {
         const re = new RegExp(`\\b${escapeRegex(tok)}\\b`,'i');
         df[tok] = docs.reduce((acc,d)=> acc + (re.test(d.norm)?1:0), 0);
      });
      function scoreDoc(d) {
         let score = 0;
         for (const tok of tokens) {
            const tf = (d.norm.match(new RegExp(`\\b${escapeRegex(tok)}\\b`,'gi')) || []).length;
            if (!tf) continue;
            const idf = Math.log((N+1)/((df[tok]||0)+1));
            score += tf * idf * (d.w||1);
         }
         // Prefer mid-length sentences
         const len = d.text.length; if (len > 60 && len < 300) score *= 1.2;
         // Keyword boost
         const keys = uniq((state.analysis.keyPhrases||[]).concat(...themes.map(t=>t.keyPhrases||[])));
         const hasKey = keys.some(k=> new RegExp(`\\b${escapeRegex(normalize(k))}\\b`).test(d.norm));
         if(hasKey) score *= 1.1;
         return score;
      }
      const top = docs
         .map(d => ({ d, s: scoreDoc(d) }))
         .sort((a,b)=>b.s-a.s)
         .slice(0,3)
         .filter(x => x.s > 0.0001);
      if (top.length) {
         const theme = top[0].d.theme;
         const answer = top.map(x=>x.d.text).join(' ');
         return `Voici ce que j'ai trouvé (approx.) dans le thème "${theme}" pour "${query}":\n\n${answer}`;
      }
      return "Désolé, je n'ai pas trouvé d'information pertinente dans le document. Essayez de reformuler.";
   }

   // --- Small text helpers ---
   function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
   function uniq(arr) { return Array.from(new Set(arr)); }
   function sliceWords(s, n) {
      const parts = (s||'').split(/\s+/).filter(Boolean).slice(0, n);
      return parts.join(' ');
   }
   function variantArticles(str) {
      // Try to perturb article numbers: 1217 -> 1216, 1218 etc
      const m = String(str).match(/(Article|Art\.)\s*([A-Z]\.)?\s*(\d+)/i);
      if (!m) return [];
      const num = parseInt(m[3], 10);
      const base = str.replace(/\d+/, String(num));
      const neighbors = [num-1, num+1, num+2].filter(x => x > 0).map(n => base.replace(/\d+/, String(n)));
      return neighbors;
   }
   function capitalize(s){ return (s||'').charAt(0).toUpperCase()+ (s||'').slice(1); }

   // Socratic Chat
   dom.socraticSend.addEventListener('click', handleSocraticChat);
   dom.socraticInput.addEventListener('keyup', (e) => e.key === 'Enter' && handleSocraticChat());

   async function handleSocraticChat() {
      const raw = dom.socraticInput.value.trim();
      if (!raw) return;
      const provider = (dom.aiProvider && dom.aiProvider.value) || 'openai';
      const apiKey = dom.apiKey ? dom.apiKey.value.trim() : '';

      // Push user message
      state.socraticHistory.push({ role: 'user', content: raw });
      dom.socraticInput.value = '';
      renderSocraticChat();

      // Disable input + show typing (as a temp assistant message)
      dom.socraticInput.disabled = true; dom.socraticSend.disabled = true;
      state.socraticHistory.push({ role: 'assistant', content: '…' });
      const typingIndex = state.socraticHistory.length - 1;
      renderSocraticChat();

   // Build a smarter Socratic prompt with focus on current theme and misconceptions
   const themes = state.analysis?.themes || [];
   const focus = themes.find(t => (t.title||'').toLowerCase().includes(raw.toLowerCase())) || themes[0] || {};
   const keyset = uniq((focus.keyPhrases||[]).concat(state.analysis?.keyPhrases||[])).slice(0,10).join(', ');
   const socraticPrompt = `Contexte du cours (extrait): ${state.rawText.substring(0, 1200)}\n\nThème ciblé: ${focus.title||'—'}\nMots-clés: ${keyset}\n\nHistorique:\n${state.socraticHistory.slice(0, -1).map(m => `${m.role}: ${m.content}`).join('\n')}\n\nRôle: tuteur socratique. NE DONNE PAS la réponse. Pose UNE question ouverte à la fois, courte (max 25 mots), qui fait préciser la définition, distinguer une exception, ou illustrer par un exemple.`;

      try {
         const answer = await askAssistantWithProviders(socraticPrompt, provider, apiKey, raw);
         const finalAns = answer ? (typeof window.__formatAssistantReply === 'function' ? window.__formatAssistantReply(answer) : answer) : null;
         state.socraticHistory[typingIndex].content = finalAns || "Je n'ai pas pu obtenir de réponse. Essayez à nouveau ou changez de provider.";
      } catch (error) {
         state.socraticHistory[typingIndex].content = `Erreur: ${error.message}`;
      } finally {
         dom.socraticInput.disabled = false; dom.socraticSend.disabled = false;
         renderSocraticChat();
      }
   }

   // --- Unified HTTP + Provider Adapter (Chat Assistant pattern) ---
   async function callHTTPJSON(url, body, { timeoutMs = 12000, headers = {} } = {}) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
         const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: ctrl.signal
         });
         const data = await res.json().catch(() => ({}));
         return { ok: res.ok, data, status: res.status };
      } finally { clearTimeout(t); }
   }

   async function callLLM(prompt, provider, apiKey) {
      try {
         // Unified backend for local + OpenAI
         if (['auto','openai','hf','ctransformers'].includes(provider)) {
            const body = {
               task: 'chat', prompt,
               provider,
               model: provider==='openai' ? 'gpt-3.5-turbo' : (window.COACH_MODEL || ''),
               temperature: 0.2, top_p: 0.9, max_tokens: 600,
               api_key: provider==='openai' ? (apiKey || null) : null
            };
            const res = await fetch('http://localhost:8000/llm/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
            const data = await res.json().catch(()=>({}));
            if (data && data.status==='ok') return data.output || '';
            return null;
         }

         if (provider === 'picoapps') {
            const url = (window.COACH_PICOAPPS_URL || 'https://backend.buildpicoapps.com/aero/run/llm-api?pk=YOUR_PK');
            const { ok, data } = await callHTTPJSON(url, { prompt }, { timeoutMs: 25000 });
            return ok && (data.status === 'success') ? (data.text || null) : null;
         }

         // Legacy direct OpenAI path (kept as fallback)
         if (provider === 'openai') {
            if (!apiKey) return null;
            const { ok, data } = await callHTTPJSON('https://api.openai.com/v1/chat/completions', {
               model: 'gpt-3.5-turbo',
               messages: [
                  { role: 'system', content: 'Prof de droit français. Réponds de manière courte et socratique.' },
                  { role: 'user', content: prompt }
               ],
               temperature: 0.2, max_tokens: 600
            }, { timeoutMs: 25000, headers: { Authorization: `Bearer ${apiKey}` } });
            return ok ? (data.choices?.[0]?.message?.content || null) : null;
         }

         // Ollama path removed
      } catch (e) {
         // Swallow to allow fallback
         return null;
      }
      return null;
   }

   async function askAssistant(rawQuestion) {
      const provider = (dom.aiProvider && dom.aiProvider.value) || 'openai';
      const apiKey = dom.apiKey ? dom.apiKey.value.trim() : '';
      const isImage = rawQuestion.startsWith('/image ');
      const q = isImage ? rawQuestion.replace('/image ', '') : rawQuestion;
      if (provider === 'picoapps' && isImage) {
         const url = (window.COACH_PICOAPPS_IMG_URL || 'https://backend.buildpicoapps.com/aero/run/image-generation-api?pk=YOUR_PK');
         const { ok, data } = await callHTTPJSON(url, { prompt: q }, { timeoutMs: 30000 });
         return ok && data.status === 'success' ? `[Image]: ${data.text}` : 'Erreur image.';
      }
      return await callLLM(q, provider, apiKey);
   }

   async function askAssistantWithProviders(prompt, provider, apiKey, raw) {
      // Try selected provider; if null and provider==='auto', fall back inside callLLM
      const ans = await askAssistant(raw?.startsWith('/image ') ? raw : prompt);
      if (ans) return ans;
      // If nothing, fallback to internal guidance question from TF-IDF context
   const internal = getInternalResponse((raw||'') + '\n' + (state.studySheet?.children?.map(c=>c.summary).join('\n')||''));
   // Convert internal retrieval into a Socratic-style question (question-only)
      const fallbackQ = (q)=>{
         const patt = /pour \"(.+?)\"/i; const m = (q||'').match(patt); const topic = m? m[1] : 'ce point';
         const starters = [
            `Quelle est la définition précise de ${topic} ?`,
            `Quelle règle générale concerne ${topic} ?`,
            `Voyez-vous une exception pour ${topic} ?`,
            `Pouvez-vous donner un exemple concret lié à ${topic} ?`
         ];
         return starters[Math.floor(Math.random()*starters.length)];
      };
      return fallbackQ(internal);
   }

   // --- SRS Logic ---
   function addToSRS(item) {
      // Avoid duplicates
      const existingIndex = state.srs.findIndex(srsItem => 
         srsItem.type === item.type && 
         (srsItem.data.question === item.data.question || srsItem.data.title === item.data.title)
      );
      if (existingIndex === -1) {
         state.srs.push(item);
      }
      renderSRS();
   }

   // --- Session Management ---
   dom.sessionBtn.addEventListener('click', () => {
      renderSessionList();
      dom.sessionModal.style.display = 'block';
   });
   dom.closeModalBtn.addEventListener('click', () => dom.sessionModal.style.display = 'none');
   window.addEventListener('click', (e) => {
      if (e.target == dom.sessionModal) {
         dom.sessionModal.style.display = 'none';
      }
   });

   dom.saveSessionBtn.addEventListener('click', () => {
      const name = dom.sessionNameInput.value.trim();
      if (!name) {
         showToast("Veuillez donner un nom à la session.", 'warn');
         return;
      }
      localStorage.setItem(`coach_session_${name}`, JSON.stringify(state));
      dom.sessionNameInput.value = '';
      renderSessionList();
   });

   dom.sessionList.addEventListener('click', (e) => {
      if (e.target.classList.contains('load-btn')) {
         const name = e.target.dataset.name;
         const savedState = localStorage.getItem(`coach_session_${name}`);
         if (savedState) {
            state = JSON.parse(savedState);
            // Backward-compatible defaults for new prefs
            if (!state.qcmMode) state.qcmMode = 'pro';
            if (!state.qcmCount) state.qcmCount = 12;
            // Backward-compatible defaults for new prefs
            if (typeof state.examMode !== 'boolean') state.examMode = false;
            // Restore autosaved edits for this session
            try {
               const autos = localStorage.getItem(`coach_autosave_sheet_${state.currentSession||name||'default'}`);
               if (autos) {
                  const parsed = JSON.parse(autos);
                  if (parsed && Array.isArray(parsed.sheets) && state.studySheet && Array.isArray(state.studySheet.children)) {
                     state.studySheet.children = state.studySheet.children.map((c,i)=> Object.assign({}, c, parsed.sheets[i]||{}));
                  }
               }
            } catch(_) {}
            // Re-render everything
            dom.textInput.value = state.rawText;
            renderAnalysis();
            renderStudySheet();
            regenerateQCMs();
            renderQCMs();
            renderSRS();
            renderChat();
            renderSocraticChat();
            dom.sessionModal.style.display = 'none';
            showToast(`Session "${name}" chargée.`, 'success');
         }
      }
      if (e.target.classList.contains('delete-btn')) {
         const name = e.target.dataset.name;
         if (confirm(`Voulez-vous vraiment supprimer la session "${name}" ?`)) {
            localStorage.removeItem(`coach_session_${name}`);
            renderSessionList();
         }
      }
   });

   function renderSessionList() {
      dom.sessionList.innerHTML = '';
      for (let i = 0; i < localStorage.length; i++) {
         const key = localStorage.key(i);
         if (key.startsWith('coach_session_')) {
            const name = key.replace('coach_session_', '');
            dom.sessionList.innerHTML += `
               <div class="session-item">
                  <span>${name}</span>
                  <div>
                     <button class="btn load-btn" data-name="${name}">Charger</button>
                     <button class="btn delete-btn" data-name="${name}">Suppr.</button>
                  </div>
               </div>
            `;
         }
      }
   }

   // --- Utility ---
   function shuffleArray(array) {
      for (let i = array.length - 1; i > 0; i--) {
         const j = Math.floor(Math.random() * (i + 1));
         [array[i], array[j]] = [array[j], array[i]];
      }
      return array;
   }

   // Deterministic RNG utilities for stable option order in exam mode
   function hashString(str){ let h=2166136261>>>0; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h>>>0; }
   function lcg(seed){ let s=(seed>>>0)||1; return ()=> (s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296; }
   function seededShuffle(arr, seed){ const a=[...arr]; const rnd=lcg(seed); for(let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

   // --- Initial Load ---
   // Try to load a default session if it exists
   const defaultState = localStorage.getItem('coach_session_default');
   if (defaultState) {
      state = JSON.parse(defaultState);
   if (!state.qcmMode) state.qcmMode = 'pro';
   if (!state.qcmCount) state.qcmCount = 12;
   if (typeof state.examMode !== 'boolean') state.examMode = false;
   // Hydrate autosaved edits if present
   try {
      const autos = localStorage.getItem(`coach_autosave_sheet_${state.currentSession||'default'}`);
      if (autos) {
         const parsed = JSON.parse(autos);
         if (parsed && Array.isArray(parsed.sheets) && state.studySheet && Array.isArray(state.studySheet.children)) {
            state.studySheet.children = state.studySheet.children.map((c,i)=> Object.assign({}, c, parsed.sheets[i]||{}));
         }
      }
   } catch(_) {}
   dom.textInput.value = state.rawText || '';
   renderAnalysis();
   renderStudySheet();
   regenerateQCMs();
   renderQCMs();
   renderSRS();
   renderChat();
   renderSocraticChat();
   }

   // Probe backend health for LLM config hints (non-blocking)
   (async ()=>{
      try{
         const r = await fetch('http://localhost:8000/health');
         const h = await r.json().catch(()=>({}));
         const issues = h?.llm?.issues || [];
         if(Array.isArray(issues) && issues.length){
            const map = {
               missing_model: "Modèle local non configuré (LLM_MODEL ou config.yml ctransformers.model).",
               model_path_not_found: "Chemin du modèle introuvable.",
               missing_model_file_for_repo: "Pour les dépôts GGUF, précisez model_file (ex: llama-2-7b.Q4_K_M.gguf).",
               unknown_backend: "Backend LLM inconnu; utilisez 'ctransformers' ou 'hf'."
            };
            const msg = issues.map(x=> map[x]||String(x)).join(' | ');
            (window.coachToast||showToast)(`LLM: ${msg}`, 'warn');
         }
      }catch(_){ /* ignore */ }
   })();

/* ===========================================================
    Générateur de questions — Professeur Nour
    Pourquoi : obtenir de meilleures questions (MCQ/QR/Cloze/VF),
    distracteurs plausibles et validation stricte, avec ou sans LLM.
    =========================================================== */

(function () {
   const $ = (s, r=document) => r.querySelector(s);

   // --------- Utilitaires (pourquoi : robustesse hors-LLM)
   const S = {
      sentSplit(txt) { return (txt||'').replace(/\s+/g,' ').split(/(?<=[\.?\!])\s+/).filter(s=>s.trim().length>0); },
      words(txt){ return (txt||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s-]/gu,' ').split(/\s+/).filter(Boolean); },
      uniq(a){ return Array.from(new Set(a)); },
      clamp(n,min,max){ return Math.max(min, Math.min(max,n)); },
      esc(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); },
      pick(a,n=1){ const c=[...a]; const out=[]; while(c.length && out.length<n){ out.push(c.splice(Math.floor(Math.random()*c.length),1)[0]); } return out; },
      shuffle(a){ return a.map(v=>[v,Math.random()]).sort((x,y)=>x[1]-y[1]).map(x=>x[0]); }
   };

   // --------- Lexique minimal (pourquoi : distracteurs crédibles)
   const LEX = {
      negations: ['ne … pas','jamais','aucun','nul','ne … plus'],
      approxAdverbs: ['souvent','parfois','généralement','rarement'],
      confusionPairs: {
         cause:'conséquence', conséquence:'cause',
         droit:'obligation', obligation:'droit',
         nécessaire:'suffisant', suffisant:'nécessaire',
         actif:'passif', passif:'actif', objectif:'subjectif', subjectif:'objectif'
      },
      genericDistractors: ['Je ne sais pas', 'Aucune de ces réponses', 'Réponse incomplète']
   };

   // --------- Extraction légère (pourquoi : fabriquer des cibles)
   function extractKeyTerms(text, k = 8) {
      const lines = (text||'').split(/\n/).map(s=>s.trim()).filter(Boolean);
      const headings = lines.filter(l=>/^#{1,3}\s+/.test(l)).map(l=>l.replace(/^#{1,3}\s+/,'').trim());
      const defs = lines.filter(l=>/[:\-–]\s/.test(l)).map(l=>l.split(/[:\-–]\s/)[0].trim());
      const words = S.words(text).filter(w=>w.length>3);
      const freq = Object.create(null);
      for (const w of words) freq[w]=(freq[w]||0)+1;
      const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, k*3).map(([w])=>w);
      return S.uniq([...headings, ...defs, ...top]).slice(0, k);
   }

   // --------- Distracteurs (pourquoi : plausibilité)
   function makeNumericDistractors(x){
      const n = Number(String(x).replace(',', '.'));
      if (!isFinite(n)) return null;
      const d = [n*1.1, n*0.9, n+1, Math.max(0,n-1)].map(v=> (Number.isInteger(n)&&Number.isInteger(v)) ? String(v) : String(+v.toFixed(2)));
      return S.uniq(d.filter(v=>v !== String(n)));
   }
   function makeLexicalDistractors(ans, context=''){
      const a = (ans||'').trim();
      const low = a.toLowerCase();
      const out = [];
      if (LEX.confusionPairs[low]) out.push(LEX.confusionPairs[low]);
      if (/\btoujours\b/i.test(context)) out.push('parfois');
      if (/\bnécessaire\b/i.test(context)) out.push('suffisant');
      if (a.length>6) out.push(a.slice(0, a.length-2));         // réponse tronquée
      out.push(a.split('').reverse().join('').slice(0, Math.max(4, a.length-3))); // bruit
      return S.uniq(out).filter(x=>x && x.toLowerCase()!==low).slice(0,3);
   }

   // --------- Gabarits de questions
   const STEMS = {
      def: (term)=>`Quelle est la meilleure définition de « ${term} » ?`,
      role: (term)=>`Quel est le rôle de « ${term} » dans ce chapitre ?`,
      chooseCorrect: (topic)=>`Laquelle des propositions suivantes est correcte à propos de « ${topic} » ?`,
      cloze: (term)=>`Complétez : ${term}`,
      tf: (topic)=>`Vrai ou faux : ${topic}`
   };

   // --------- Validation forte (pourquoi : éviter QCM bancals)
   function validateMCQ(it){
      const errs=[];
      if (!it || typeof it!=='object') errs.push('item invalid');
      if (!Array.isArray(it.options) || it.options.length!==4) errs.push('4 options requises');
      if (!Number.isInteger(it.answer_index) || it.answer_index<0 || it.answer_index>3) errs.push('index hors bornes');
      const set = new Set(it.options.map(o=>o.trim().toLowerCase()));
      if (set.size !== it.options.length) errs.push('doublons options');
      const answer = it.options[it.answer_index] || '';
      if (/toutes/i.test(answer)) errs.push('interdit: "Toutes les réponses"');
      if ((it.question||'').toLowerCase().includes((answer||'').toLowerCase())) errs.push('réponse dans la question');
      return { ok: errs.length===0, errors: errs };
   }

   // --------- Génération locale MCQ
   function mcqFromTerm(term, sectionText, topic){
      const sentences = S.sentSplit(sectionText);
      const support = sentences.find(s=> new RegExp(`\\b${escapeReg(term)}\\b`, 'i').test(s)) || sentences[0] || sectionText.slice(0,240);
      let correct = '';
      // Heuristique déf : partie après ":" ou après "est/constitue"
      const colon = support.split(/[:\-–]\s+/);
      if (colon.length>1) correct = colon.slice(1).join(' ').trim();
      if (!correct) {
         const m = support.match(new RegExp(`${escapeReg(term)}\\s+(?:est|constitue|signifie)\\s+([^\\.\\!\\?]+)`, 'i'));
         correct = (m && m[1]) ? m[1].trim() : support.trim();
      }
      correct = truncate(cleanSentence(correct), 160);
      // Distracteurs
      const numDs = makeNumericDistractors(correct);
      const lexDs = makeLexicalDistractors(correct, support);
      const pool = (numDs || []).concat(lexDs);
      while(pool.length < 3) pool.push(S.pick(LEX.genericDistractors,1)[0]);
      const options = S.shuffle([correct, ...S.pick(pool,3)]);
      const answer_index = options.indexOf(correct);
      const item = {
         id: `mcq_${hash(term+support).slice(0,6)}`,
         difficulty: pickDifficulty(support),
         bloom: pickBloom(support),
         question: STEMS.def(term),
         options, answer_index,
         rationale: truncate(`Réponse appuyée par l’énoncé : « ${cleanSentence(support)} »`, 200),
         citations: []
      };
      const v = validateMCQ(item);
      if (!v.ok) {
         // Fallback : question générique
         const opts = S.shuffle([
            `Définition correcte de ${term}`, `Exemple sans définition`, `Affirmation incorrecte`, `Analogie non pertinente`
         ]);
         return {
            id: `mcq_${hash(term).slice(0,6)}`,
            difficulty:'easy', bloom:'rappel',
            question: STEMS.chooseCorrect(topic||term),
            options: opts, answer_index: 0,
            rationale:'Formulation de secours (heuristique).',
            citations:[]
         };
      }
      return item;
   }

   // --------- Cloze (texte à trou) & Vrai/Faux
   function clozeFromSentence(sentence){
      const words = sentence.split(/\s+/);
      if (words.length < 6) return null;
      const i = Math.max(1, Math.floor(words.length*0.35));
      const removed = words[i].replace(/[^\p{L}\p{N}-]/gu,'');
      if (!removed || removed.length<3) return null;
      const stmt = words.map((w,idx)=> idx===i ? '____' : w).join(' ');
      return { type:'cloze', question: STEMS.cloze(stmt), answer: removed };
   }
   function trueFalseFromSentence(sentence){
      const flip = sentence
         .replace(/\btoujours\b/gi, 'parfois')
         .replace(/\bne\b/gi,'')
         .replace(/\bjamais\b/gi,'souvent');
      const isFalse = Math.random()>0.5;
      const text = isFalse ? flip : sentence;
      return { type:'truefalse', question: STEMS.tf(text), answer: isFalse ? 'faux' : 'vrai' };
   }

   // --------- Sélection difficulté/Bloom approx
   function pickDifficulty(s){ const len = (s||'').length; return len<80 ? 'easy' : len<180 ? 'medium' : 'hard'; }
   function pickBloom(s){ return /\bcalcul|appliquer|résoudre|démontrer\b/i.test(s) ? 'application' : /\banalyser|comparer|justifier\b/i.test(s) ? 'analyse' : 'compréhension'; }

   // --------- Nettoyage/formatage
   function cleanSentence(s){ return (s||'').replace(/\s+/g,' ').replace(/^[\-\•\–]\s*/,'').trim(); }
   function truncate(s, n){ return s.length>n ? s.slice(0,n-1)+'…' : s; }
   function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
   function hash(s){ let h=0,i,chr; for(i=0;i<s.length;i++){ chr=s.charCodeAt(i); h=((h<<5)-h)+chr; h|=0; } return (h>>>0).toString(16); }

   // --------- Génération principale
   async function generateQuestions(section, opts={ mcq:4, cloze:1, tf:1 }) {
      const title = section.title || 'section';
      const text = (section.body || section.longHTML || section.mediumHTML || '').replace(/<[^>]+>/g,' ');
      const terms = extractKeyTerms(text, Math.max(opts.mcq, 6));
      const sent = S.sentSplit(text);
      const out = { mcq:[], cloze:[], tf:[], short:[] };

      // 1) MCQ
      for (const t of terms.slice(0, opts.mcq + 3)) {
         out.mcq.push(mcqFromTerm(t, text, title));
         if (out.mcq.length >= opts.mcq) break;
      }

      // 2) Cloze
      for (const s of sent) {
         const cz = clozeFromSentence(s);
         if (cz) { out.cloze.push(cz); if (out.cloze.length>=opts.cloze) break; }
      }

      // 3) Vrai/Faux
      for (const s of S.pick(sent, Math.max(opts.tf,2))) {
         out.tf.push(trueFalseFromSentence(cleanSentence(s)));
         if (out.tf.length>=opts.tf) break;
      }

      // 4) Questions courtes
      for (const t of terms.slice(0, 3)) {
         out.short.push({ type:'short', question:`Expliquez brièvement : ${t}` });
      }

      // 5) Si un LLM est disponible, on l'utilise pour raffiner
      try{
         if (window.__llm_generate) {
            const llm = await window.__llm_generate({
               task:'make-mcq',
               prompt: 'Tu es Professeur Nour. Génère des MCQ FR de qualité (1 seule bonne réponse, 3 distracteurs plausibles, justification courte). Réponds JSON.',
               passages: [{ id:'local', text: text.slice(0, 3500) }],
               topics: [title],
               count: opts.mcq
            });
            // Si schéma attendu, on remplace nos MCQ par ceux du LLM validés
            if (llm && Array.isArray(llm.items)) {
               const validated = llm.items.map(it=>{
                  const v = validateMCQ(it);
                  return v.ok ? it : null;
               }).filter(Boolean);
               if (validated.length) out.mcq = validated;
            }
         }
      } catch { /* sécurité */ }

      return out;
   }

      // Version synchrone (heuristique seule, sans LLM)
      function generateQuestionsSync(section, opts={ mcq:4, cloze:0, tf:0 }){
         const title = section.title || 'section';
         const text = (section.body || section.longHTML || section.mediumHTML || '').replace(/<[^>]+>/g,' ');
         const terms = extractKeyTerms(text, Math.max(opts.mcq, 6));
         const sent = S.sentSplit(text);
         const out = { mcq:[], cloze:[], tf:[], short:[] };
         for (const t of terms.slice(0, opts.mcq + 3)) {
            out.mcq.push(mcqFromTerm(t, text, title));
            if (out.mcq.length >= opts.mcq) break;
         }
         // Cloze/TF optionnels, non essentiels pour QCM tab
         for (const s of sent){ const cz=clozeFromSentence(s); if(cz){ out.cloze.push(cz); if(out.cloze.length>=opts.cloze) break; } }
         for (const s of S.pick(sent, Math.max(opts.tf,0))) { out.tf.push(trueFalseFromSentence(cleanSentence(s))); if (out.tf.length>=opts.tf) break; }
         for (const t of terms.slice(0, 3)) out.short.push({ type:'short', question:`Expliquez brièvement : ${t}` });
         return out;
      }

   // --------- Expose API globale
   window.NourQuestionGenerator = {
      generateQuestions,
      generateQuestionsSync,
      validateMCQ,
      extractKeyTerms
   };

   // --------- Intégration Parcours (remplace ton buildQuickQuestions)
   // Pourquoi : uniformiser les "questions courtes" et les MCQ rapides
   const grList = $('#gr-qq-list');
   if (grList) {
      const oldBuild = window.buildQuickQuestions; // si existait
      window.buildQuickQuestions = function (sec) {
         const text = (sec.longHTML || sec.mediumHTML || sec.shortHTML || '').replace(/<[^>]+>/g,' ');
         const s = { title: sec.title || 'section', body: text };
         // MCQ count selon durée (2..6)
         const durEl = $('#gr-duration');
         const durMin = durEl ? Number(durEl.value||30) : 30;
         const mcqN = S.clamp(Math.round(durMin/10), 2, 6);
         const fake = { mcq: mcqN, cloze:0, tf:0 };
         return generateQuestions(s, fake).then(res => {
            const raw = (res.mcq||[]).slice(0,mcqN);
            const items = raw.map((it)=>{
               const ans = (it.options||[])[Number(it.answer_index)||0] || '';
               // Ensure exactly 4 options and dedup/pad
               const fillers=['Je ne sais pas','Exemple sans définition','Affirmation incorrecte','Réponse incomplète'];
               const seen=new Set(); let opts=[];
               for(const o of (it.options||[])){
                  const v=String(o||'').trim(); if(!v||seen.has(v)) continue; opts.push(v); seen.add(v);
               }
               if(ans && !opts.includes(ans)) { opts.unshift(ans); seen.add(ans); }
               while(opts.length<4){ const f=fillers[opts.length%fillers.length]; opts.push(seen.has(f)? f+' ' : f); seen.add(f); }
               opts = opts.slice(0,4);
               const answer_index = Math.max(0, opts.indexOf(ans));
               return { question: it.question, options: opts, answer_index, bloom: it.bloom||'rappel' };
            });
            const nameSeed = `qq-${Date.now()}-`;
            const html = items.map((it, idx)=>`
               <div class="qcm-item">
                  <div class="qcm-meta"><span class="badge">Q${idx+1}</span> <span class="badge easy">${it.bloom}</span></div>
                  <p>${S.esc(it.question)}</p>
                  <div class="qcm-options">
                     ${it.options.map((opt,i)=>`
                        <label><input type="radio" name="${nameSeed}${idx}" value="${i}">${S.esc(opt)}</label>
                     `).join('')}
                  </div>
               </div>`).join('');
            grList.innerHTML = html;
            grList.dataset.answers = JSON.stringify(items.map(i=>i.answer_index));
            return items;
         }).catch(()=> (oldBuild ? oldBuild(sec) : []));
      };
   }

   // --------- Intégration QCM (utilisation via QcmUpgrade si présent)
   // On enveloppe QcmUpgrade.generate pour privilégier ce générateur
      const wrapQcmUpgrade = () => {
      try{
         const prev = (window.QcmUpgrade && window.QcmUpgrade.generate) ? window.QcmUpgrade.generate : null;
         window.QcmUpgrade = window.QcmUpgrade || {};
         window.QcmUpgrade.generate = function(analysis, target=12){
               try{
                  const themes = (analysis && Array.isArray(analysis.themes)) ? analysis.themes : [];
                  const body = themes.map(t=> (
                     // Use multiple fallbacks to avoid empty input
                     (t.content||t.raw||'') + '\n' +
                     ((t.sentences||[]).join(' ')||'') + '\n' +
                     (t.summaryLong||t.summaryShort||'')
                  )).join('\n\n');
                  const out = generateQuestionsSync({ title: (themes[0]?.title||'Chapitre'), body }, { mcq: target, cloze: 0, tf: 0 });
                  const items = (out.mcq||[]).slice(0, target).map((it, i)=>({
                     id: it.id || `nq_${i}`,
                     type: 'pro',
                     q: it.question,
                     options: it.options,
                     answer: Number(it.answer_index)||0,
                     explain: it.rationale||''
                  }));
                  return items;
               }catch(_){
               return prev ? prev(analysis, target) : [];
            }
         };
      }catch(_){ /* ignore */ }
   };
   wrapQcmUpgrade();

   // Adapter le QCM global au changement de durée (Parcours)
   const durEl = $('#gr-duration');
   if (durEl) {
      durEl.addEventListener('change', ()=>{
         try{
            const n = S.clamp(Math.round(Number(durEl.value||30)/5), 6, 20);
            if (window.state) { window.state.qcmCount = n; }
            if (typeof window.regenerateQCMs==='function') window.regenerateQCMs();
            if (typeof window.renderQCMs==='function') window.renderQCMs();
         }catch(_){/* noop */}
      });
   }

   // Fallback avatar CSS var si mascotte absente
   (function ensureAvatarVar(){
      const test = new Image();
      test.onload = ()=>{};
   test.onerror = ()=>{ try{ document.documentElement.style.setProperty('--nour-avatar-url', "url('assets/nour-avatar.png')"); }catch(_){} };
   test.src = 'prof-mascotte-2.png';
   })();

      // Favicon fallback si mascotte absente
      (function ensureFavicon(){
         try{
            const link = document.querySelector("link[rel='icon']");
            if (!link) return;
            const img = new Image();
            img.onload = ()=>{};
            img.onerror = ()=>{
               const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0B1020"/><text x="50%" y="56%" text-anchor="middle" font-size="34" fill="#FF9F1C" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">N</text></svg>`;
               link.href = 'data:image/svg+xml;utf8,'+encodeURIComponent(svg);
            };
            img.src = link.href || '';
         }catch(_){/* noop */}
      })();
})();


// Persona "Professeur Nour" : salutation automatique + avatar dans le chat
(() => {
   const $ = (s, r=document) => r.querySelector(s);
   const chatWrap = $('#chat-messages');
   const socrWrap = $('#socratic-messages');

   function greetOnce(wrapper, text) {
      if (!wrapper) return;
      if (wrapper.dataset.greeted === '1') return;
      const msg = document.createElement('div');
      msg.className = 'chat-message assistant-message prof-nour placeholder';
      msg.textContent = text;
      wrapper.appendChild(msg);
      wrapper.dataset.greeted = '1';
   }

   // Greet on load (in case the tab is already visible)
   greetOnce(chatWrap, 'Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?');
   greetOnce(socrWrap, 'Bonjour, je suis Professeur Nour. Explorons votre concept pas à pas !');

   // Greet when switching to Chat/Socratic tabs
   document.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-link');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === 'chat') greetOnce($('#chat-messages'), 'Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?');
      if (tab === 'socratic') greetOnce($('#socratic-messages'), 'Bonjour, je suis Professeur Nour. Explorons votre concept pas à pas !');
   });

    // Prefix assistant replies globally
    window.__formatAssistantReply = function(text){ return 'Professeur Nour : ' + String(text||''); };
})();

// ===== Plein écran auto sur tous les onglets sauf "Analyse" =====
(() => {
   const setWide = (on) => {
      document.body.classList.toggle('layout-wide', on);
      try{ localStorage.setItem('layout_wide', on ? '1' : '0'); }catch(_){ }
   };
   // Par défaut: plein écran (sauf si l'utilisateur a explicitement désactivé)
   if (localStorage.getItem('layout_wide') !== '0') setWide(true);

   document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('.tab-link') : null;
      if (!t) return;
      const isAnalyse = t.dataset && t.dataset.tab === 'analyse';
      setWide(!isAnalyse);
   });
})();

/* ===== UI Enhancements: largeur + animations tabs (global) ===== */
(() => {
   // Forcer la mise en page large par défaut (toggle mémorisé)
   const btn = document.getElementById('toggleWide');
   const apply = (on) => {
      document.body.classList.toggle('layout-wide', on);
      try{ localStorage.setItem('layout_wide', on ? '1' : '0'); }catch(_){ }
      if (btn) btn.textContent = on ? '↔️ Réduire' : '↔️ Étendre';
   };
   apply((()=>{ try{ return localStorage.getItem('layout_wide') !== '0'; }catch(_){ return true; } })());

   if (btn) btn.addEventListener('click', (ev) => {
      // ripple coords for CSS var
      const r = ev.currentTarget.getBoundingClientRect();
      const x = ((ev.clientX||0) - r.left) + 'px';
      const y = ((ev.clientY||0) - r.top) + 'px';
      ev.currentTarget.style.setProperty('--rx', x);
      ev.currentTarget.style.setProperty('--ry', y);
      apply(!document.body.classList.contains('layout-wide'));
   });

   // Micro animation à l'ouverture d'un onglet (rejoue l'animation)
   document.addEventListener('click', (e) => {
      const t = e.target.closest('.tab-link');
      if (!t) return;
      const id = t.dataset.tab;
      const pane = document.getElementById(id);
      if (!pane) return;
      pane.classList.remove('anim-enter');
      // force reflow pour relancer l'animation
      void pane.offsetWidth;
      pane.classList.add('anim-enter');
      setTimeout(()=>pane.classList.remove('anim-enter'), 360);
   });

   // Animation initiale sur l'onglet actif
   const first = document.querySelector('.tab-pane.active');
   if (first) { first.classList.add('anim-enter'); setTimeout(()=>first.classList.remove('anim-enter'), 360); }
})();

   // === UI Addon: Brand header + Flashcards (Quizlet-like) ===
   (function(){
      function escapeHTML2(s){ try{ return escapeHTML ? escapeHTML(s) : (s||'').replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }catch(_){ return String(s||''); } }
      function mountHeader(){
         const mainContainer = document.querySelector('main.container');
         if(!mainContainer || document.querySelector('.app-header')) return;
         const header = document.createElement('div'); header.className='app-header';
             header.innerHTML = `
                <div class="app-brand">
                   <span class="logo">${logoSVG()}</span>
                   <span>Coach – Académie des Chouettes</span>
                </div>
           <div class="app-tools">
             <button class="theme-toggle" type="button" aria-pressed="false">Thème</button>
           </div>`;
         mainContainer.prepend(header);
         const btn = header.querySelector('.theme-toggle');
         const key='coach_theme_dark';
         const apply = on => document.body.classList.toggle('theme-dark', !!on);
         const cur = localStorage.getItem(key)==='1'; apply(cur); btn.setAttribute('aria-pressed', cur?'true':'false');
         btn.onclick=()=>{ const on = !(localStorage.getItem(key)==='1'); localStorage.setItem(key,on?'1':'0'); btn.setAttribute('aria-pressed', on?'true':'false'); apply(on); };
      }
      function logoSVG(){
         return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 44 44" aria-hidden="true">
           <defs><radialGradient id="g" cx="50%" cy="35%" r="75%"><stop offset="0%" stop-color="#fff"/><stop offset="55%" stop-color="#E7ECFF"/><stop offset="100%" stop-color="#C9D3FF"/></radialGradient></defs>
           <circle cx="22" cy="22" r="20" fill="url(#g)"/>
           <circle cx="16" cy="17" r="4" fill="#0B1020"/><circle cx="28" cy="17" r="4" fill="#0B1020"/>
           <rect x="20" y="21" width="6" height="6" transform="rotate(45 23 24)" fill="#FFD166"/>
         </svg>`;
      }
      function mountFlashcardsPane(){
         const tabs = document.querySelector('.tabs'); const tabContent=document.getElementById('tab-content');
         if(!tabs || !tabContent) return;
         // Create tab link only if absent
         if(!tabs.querySelector('[data-tab="flashcards-pane"]')){
            const link=document.createElement('button'); link.className='tab-link'; link.dataset.tab='flashcards-pane'; link.textContent='Cartes'; link.role='tab'; link.setAttribute('aria-selected','false'); link.setAttribute('tabindex','-1'); link.setAttribute('aria-controls','flashcards-pane'); tabs.appendChild(link);
         }
         // Create pane if absent
         if(document.getElementById('flashcards-pane')) return;
         const pane=document.createElement('div'); pane.className='tab-pane'; pane.id='flashcards-pane'; pane.setAttribute('role','tabpanel'); pane.setAttribute('aria-hidden','true'); pane.setAttribute('tabindex','0');
         pane.innerHTML = `
            <div class="fc-toolbar">
              <button class="btn" id="fc-build">Générer depuis QCM</button>
              <button class="btn" id="fc-flip">Retourner (Espace)</button>
              <div class="paw-progress" style="flex:1"><div class="bar"></div></div>
              <div class="fc-stats" aria-live="polite"></div>
            </div>
            <div class="fc-deck" aria-live="polite"></div>
            <div class="fc-actions">
              <button class="btn" id="fc-wrong">Je ne savais pas (2)</button>
              <button class="btn primary" id="fc-right">Je savais (1)</button>
            </div>`;
         tabContent.appendChild(pane);
      }
      function getDeck(){
         const st = window.__coach && window.__coach.getState ? window.__coach.getState() : null;
         const qcm = st && Array.isArray(st.qcm) ? st.qcm : [];
         const deck = qcm.map((q,i)=>({ id:i, front:`Q${i+1}. ${q.question||''}`, back:`${q.answer||''}${q.meta?.proof?`\n\n💡 ${q.meta.proof}`:''}` })).filter(c=>c.front && c.back);
         return deck.length? deck : [{ id:0, front:'Aucune question pour l’instant.', back:'Générez les QCM puis cliquez “Générer depuis QCM”.' }];
      }
      const FC = {
         deck:[], i:0, flipped:false, elDeck:null, elStats:null, elBar:null,
         reset(d){ this.deck=d||[]; this.i=0; this.flipped=false; this.render(); },
         next(){ if(this.i < this.deck.length-1){ this.i++; this.flipped=false; this.render(); } },
         prev(){ if(this.i>0){ this.i--; this.flipped=false; this.render(); } },
         flip(){ this.flipped=!this.flipped; this.render(true); },
         mark(right){ const key='fc_stats'; const s=JSON.parse(localStorage.getItem(key)||'{"right":0,"wrong":0,"total":0}'); right? s.right++ : s.wrong++; s.total++; localStorage.setItem(key, JSON.stringify(s)); try{ (window.coachToast||showToast)( right? 'Bien joué !' : 'On révise et on y retourne ✨', right? 'success':'warn'); }catch(_){} this.updateStats(); this.next(); },
         mount(){ const pane=document.getElementById('flashcards-pane'); if(!pane) return; this.elDeck=pane.querySelector('.fc-deck'); this.elStats=pane.querySelector('.fc-stats'); this.elBar=pane.querySelector('.paw-progress .bar'); this.bind(pane); this.updateStats(); },
         bind(p){ p.querySelector('#fc-build').onclick=()=>{ this.reset(getDeck()); try{ (window.coachToast||showToast)('Cartes générées','success'); }catch(_){} }; p.querySelector('#fc-flip').onclick=()=>this.flip(); p.querySelector('#fc-right').onclick=()=>this.mark(true); p.querySelector('#fc-wrong').onclick=()=>this.mark(false);
            window.addEventListener('keydown',(e)=>{ if(!p.classList.contains('active')) return; if(e.code==='Space'){ e.preventDefault(); this.flip(); } if(e.key==='ArrowRight') this.next(); if(e.key==='ArrowLeft') this.prev(); if(e.key==='1') this.mark(true); if(e.key==='2') this.mark(false); }); },
         render(onlyFlip=false){ if(!this.elDeck) return; const card=this.deck[this.i]||{front:'—',back:''}; const pct=Math.round(((this.i+1)/Math.max(1,this.deck.length))*100); if(!onlyFlip){ this.elDeck.innerHTML=`<article class="fc-card ${this.flipped?'is-flipped':''}" aria-live="polite" aria-label="Carte"><div class="face front"><h3>${escapeHTML2(card.front)}</h3></div><div class="face back"><p>${escapeHTML2(card.back).replace(/\n/g,'<br>')}</p></div></article>`; } else { const el=this.elDeck.querySelector('.fc-card'); if(el) el.classList.toggle('is-flipped', this.flipped); } if(this.elBar) this.elBar.style.width=pct+'%'; this.updateStats(); },
         updateStats(){ const s=JSON.parse(localStorage.getItem('fc_stats')||'{"right":0,"wrong":0,"total":0}'); const info=`${this.i+1}/${Math.max(1,this.deck.length)} • ✔︎ ${s.right} · ✖︎ ${s.wrong}`; if(this.elStats) this.elStats.textContent=info; }
      };
      // Mount after initial renders
      setTimeout(()=>{ mountHeader(); mountFlashcardsPane(); FC.mount(); FC.reset(getDeck()); }, 0);
   })();

   // --- Expose minimal read-only API for addons ---
   window.__coach = {
      getState: () => state,
      onQcmChanged: (fn) => { try { fn(state.qcm || []); } catch(_){} }
   };
});

// === revision-flow-addon (embedded) ===
(function(){
   const STOP = new Set('au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous'.split(/\s+/));
   function normalize(text){ return (text||'').toLowerCase().normalize('NFD').replace(/[^\p{L}\s]/gu,' '); }
   function splitSentences(text){ return (text||'').replace(/([.!?])+/g,'$1|').split('|').map(s=>s.trim()).filter(Boolean); }
   function uniq(arr){ return [...new Set((arr||[]).map(x=>String(x).trim()).filter(Boolean))]; }
   function topKeyPhrases(text,k=15){
      const words=normalize(text).split(/\s+/).filter(Boolean);
      const phrases=[]; let cur=[];
      for(const w of words){ if(STOP.has(w)){ if(cur.length){phrases.push(cur); cur=[];} } else cur.push(w); }
      if(cur.length) phrases.push(cur);
      const freq=new Map(), degree=new Map();
      for(const ph of phrases){
         const uniqW=new Set(ph);
         for(const w of ph){ freq.set(w,(freq.get(w)||0)+1); degree.set(w,(degree.get(w)||0)+(ph.length-1)); }
         for(const w of uniqW){ degree.set(w,(degree.get(w)||0)+(uniqW.size-1)); }
      }
      const scoreWord=new Map(); for(const [w,f] of freq.entries()){ scoreWord.set(w,(degree.get(w)||0)/f); }
      const phraseScores=phrases.map(ph=>({p:ph.join(' '),score:ph.reduce((s,w)=>s+(scoreWord.get(w)||0),0)}));
      return uniq(phraseScores.sort((a,b)=>b.score-a.score).map(x=>x.p)).slice(0,k);
   }
   function rankSentences(text, keywords){
      const sents=splitSentences(text), norm=sents.map(s=>normalize(s)), total=sents.length, idf=new Map();
      for(const k of (keywords||[])){ const r=new RegExp(`\\b${k}\\b`,'i'); const c=norm.filter(s=>r.test(s)).length; idf.set(k, Math.log((1+total)/(1+c))+1); }
      const scored=sents.map((s,i)=>{ let score=0; const n=norm[i]; for(const k of (keywords||[])){ const m=n.match(new RegExp(`\\b${k}\\b`,'gi')); if(m) score+=m.length*(idf.get(k)||1); } return {s,score}; });
      return scored.sort((a,b)=>b.score-a.score).map(x=>x.s);
   }
   function htmlEscape(str){return (str||'').replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}

   function buildLongSheet(theme){
      const text = theme.raw || '';
      const sents = splitSentences(text);
      const kws = theme.keywords?.length ? theme.keywords : topKeyPhrases(text, 15);
      const pick = (re, max) => sents.filter(s=>re.test(s)).slice(0,max);
      const join = arr => arr.join(' ');
      const ranked = rankSentences(text, kws||[]);
      const ensure = (arr,min,pool=ranked)=> (arr.length>=min?arr:arr.concat(pool.filter(s=>!arr.includes(s)).slice(0,min-arr.length)));

      const def   = ensure(pick(/\b(définition|se définit|est|consiste)\b/i,6),4);
      const princ = ensure(pick(/\b(principe|en règle|en principe)\b/i,8),6);
      const exc   = ensure(pick(/\b(exception|sauf|sauf si|sauf lorsque)\b/i,8),4);
      const juris = ensure(pick(/\b(arr[êe]t|cour de cassation|conseil d[’']état|ce\b|cjue|jurisprudence)\b/i,10),6);
      const ex    = ensure(pick(/\b(par exemple|exemple|illustration|cas pratique)\b/i,8),4);
      const piege = ensure(pick(/\b(attention|ne pas confondre|confusion|pi[eè]ge)\b/i,6),3);

      const mk = [
         `# ${theme.title||'Thème'}`,
         `## Définition`, join(def),
         `## Principe`, join(princ),
         `## Exceptions`, join(exc)||'—',
         `## Jurisprudence clé`, join(juris)||'—',
         `## Exemples`, join(ex)||'—',
         `## Pièges fréquents`, join(piege)||'—',
         `## Questions-types d’examen`,
         ['- Expliquez la notion.','- Donnez une exception et sa justification.','- Illustrez par un cas pratique bref.','- Quelle portée jurisprudentielle ?'].join('\n'),
         `## Mots-clés`, (kws||[]).slice(0,20).join(', ')||'—',
         `## Articles cités`, (theme.refs||[]).slice(0,12).join(', ')||'—'
      ].join('\n\n');
      return mk;
   }
   function buildLongSheetHTML(theme){
      const md = buildLongSheet(theme);
      const html = md
         .replace(/^# (.*)$/mg,'<h3>$1</h3>')
         .replace(/^## (.*)$/mg,'<h4>$1</h4>')
         .replace(/^- (.*)$/mg,'<li>$1</li>')
         .replace(/\n{2,}/g,'</p><p>')
         .replace(/\n/g,'<br>');
      return `<article class="qcm-item"><p>${html}</p></article>`;
   }

   function themeDifficultyIndex(analysis, state){
      const arr = (analysis.themes||[]).map((t,i)=>({i,title:t.title||'',score:0}));
      const spaced = state?.spaced || [];
      const low = new Set(state?.lowConfidence||[]);
      arr.forEach(x=>{
         if(low.has(x.title)) x.score+=2;
         const hits = spaced.filter(q =>
            ((q.explain||'').toLowerCase().includes((x.title||'').toLowerCase())) ||
            ((q.q||'').toLowerCase().includes((x.title||'').toLowerCase()))
         ).length;
         x.score += Math.min(3,hits);
      });
      return arr.sort((a,b)=>b.score-a.score).map(x=>x.i);
   }
   function buildSessionPlan(analysis, state){
      const dur = Number((state?.duration)||60);
      const themeIdx = themeDifficultyIndex(analysis, state).slice(0, Math.max(2, Math.floor(dur/20)));
      const perThemeLearnMin = Math.max(6, Math.floor(dur/(3*Math.max(2,themeIdx.length||1))));
      const steps = [{type:'diagnostic', size:5}];
      for(const i of themeIdx){
         steps.push({type:'read', theme:i});
         steps.push({type:'learn', theme:i, minutes:perThemeLearnMin});
         steps.push({type:'practice', theme:i, size:4});
         steps.push({type:'recall', theme:i, prompts:3});
      }
      steps.push({type:'test', size:8});
      return steps;
   }
   function renderStepLabel(analysis, s){
      const t = (i)=> htmlEscape(analysis.themes[i]?.title||'');
   if(s.type==='diagnostic') return `<li>Diagnostic (QCM rapides ×${s.size})</li>`;
   if(s.type==='read') return `<li>Lecture guidée – ${t(s.theme)}</li>`;
      if(s.type==='learn') return `<li>Apprentissage – ${t(s.theme)} (${s.minutes} min)</li>`;
      if(s.type==='practice') return `<li>Pratique QCM – ${t(s.theme)} (×${s.size})</li>`;
      if(s.type==='recall') return `<li>Rappel actif – ${t(s.theme)} (3 réponses ouvertes)</li>`;
      if(s.type==='test') return `<li>Test final (×${s.size})</li>`;
      return `<li>${s.type}</li>`;
   }
   function renderFlow(analysis, state){
      const container = document.getElementById('flow-output');
      if(!container) return;
   // If Guided Reading UI is mounted, don't overwrite it
   if (container.querySelector('#guided-reading')) return;
      const plan = buildSessionPlan(analysis, state);
      container.innerHTML = `
         <div class="chat-input-area" style="gap:8px; border:none; align-items:center">
            <label>Durée (min)
               <select id="flowDuration" class="input" style="min-width:90px; margin-left:6px">
                  ${[30,45,60,75,90].map(n=>`<option value="${n}" ${Number(state.duration)===n?'selected':''}>${n}</option>`).join('')}
               </select>
            </label>
            <button id="flowUpdate" class="btn">Mettre à jour</button>
            <button id="startFlow" class="btn primary" style="margin-left:auto">Démarrer</button>
         </div>
         <ol class="plan">${plan.map(s=>renderStepLabel(analysis,s)).join('')}</ol>
         <div id="flowStage" style="margin-top:10px"></div>`;
      document.getElementById('startFlow').onclick = ()=> runFlow(analysis, state, plan);
      document.getElementById('flowUpdate').onclick = ()=>{
         const sel = document.getElementById('flowDuration');
         const val = Number(sel && sel.value || state.duration || 60);
         const next = { ...state, duration: val };
         window.__coach_state = next;
         renderFlow(analysis, next);
      };
   }
   function renderRecallBlock(theme){
      const prompts = [
         'Donnez la définition.',
         'Citez une exception et sa justification.',
         'Illustrez par un cas pratique bref.'
      ].map(p=>`<div class="qcm-item"><b>${p}</b><br><textarea placeholder="Répondez ici…"></textarea></div>`).join('');
      return `<h4>Rappel actif – ${htmlEscape(theme.title||'')}</h4>${prompts}<div class="warn" style="margin-top:8px">Comparez ensuite avec la fiche longue pour vous auto-corriger.</div>`;
   }
   function runFlow(analysis, state, steps){
      let i=0; const stage=document.getElementById('flowStage');
      const nextBtn = document.createElement('button'); nextBtn.textContent='Suivant'; nextBtn.className='btn';
      nextBtn.onclick = ()=>{ i++; doStep(); };
      function doStep(){
         if(i>=steps.length){ stage.innerHTML='<div class="qcm-item" style="border-left:4px solid #28a745">Session terminée 🎉</div>'; return; }
         const s=steps[i];
         if(s.type==='read'){
            const theme = analysis.themes[s.theme];
            const paras = (window.__coach?.getState?.().longSheets?.[s.theme]?.paragraphs) || [];
            let idx = 0;
            const container = document.createElement('div'); container.className='qcm-item';
            const text = document.createElement('div'); text.style.lineHeight='1.6'; text.style.marginBottom='10px';
            const nav = document.createElement('div');
            const prev = document.createElement('button'); prev.className='btn'; prev.textContent='Précédent'; prev.disabled=true;
            const next = document.createElement('button'); next.className='btn primary'; next.textContent='Suivant';
            const meta = document.createElement('div'); meta.className='badge'; meta.style.marginLeft='8px';
            nav.append(prev, next, meta);
            function render(){
               text.innerHTML = `<h3>${escapeHTML(theme.title||'')}</h3>${(paras[idx]?`<p>${escapeHTML(paras[idx])}</p>`:'')}`;
               meta.textContent = `${idx+1}/${Math.max(1, paras.length||1)}`;
               prev.disabled = idx===0; next.textContent = (idx>=paras.length-1)? 'Terminer' : 'Suivant';
            }
            prev.onclick = ()=>{ if(idx>0){ idx--; render(); } };
            next.onclick = ()=>{ if(idx<paras.length-1){ idx++; render(); } else { i++; doStep(); } };
            container.append(text, nav); stage.appendChild(container); render();
         } else if(s.type==='learn'){
            stage.innerHTML = buildLongSheetHTML(analysis.themes[s.theme]); stage.appendChild(nextBtn);
         }else if(s.type==='practice'){
            stage.innerHTML = `<div class="qcm-item">Répondez aux QCM dans l’onglet “QCM” pour « ${htmlEscape(analysis.themes[s.theme].title||'')} », puis cliquez Suivant.</div>`; stage.appendChild(nextBtn);
         }else if(s.type==='diagnostic'){
            stage.innerHTML = `<div class="qcm-item">Diagnostic lancé (préparez quelques QCM dans l’onglet “QCM”), puis cliquez Suivant.</div>`; stage.appendChild(nextBtn);
         }else if(s.type==='recall'){
            stage.innerHTML = renderRecallBlock(analysis.themes[s.theme]); stage.appendChild(nextBtn);
         }else if(s.type==='test'){
            stage.innerHTML = `<div class="qcm-item">Test final : faites un lot de QCM dans l’onglet “QCM”.</div>`; stage.appendChild(nextBtn);
         }
      }
      doStep();
   }
   function mountLongSheetUI(analysis){
      const sheetRoot = document.getElementById('sheet-output'); if(!sheetRoot) return;
      const sel = document.createElement('select'); sel.className='input'; sel.style.minWidth='260px';
      sel.innerHTML = (analysis.themes||[]).map((t,i)=>`<option value="${i}">${htmlEscape(t.title||('Thème '+(i+1)))}</option>`).join('');
      const toggle = document.createElement('label'); toggle.className='btn'; toggle.style.marginLeft='8px';
      toggle.innerHTML = `<input type="checkbox" id="longMode" style="margin-right:6px">Fiche longue`;
      const wrap = document.createElement('div'); wrap.id='longSheetWrap'; wrap.style.marginTop='8px';
      sheetRoot.innerHTML=''; const row = document.createElement('div'); row.className='chat-input-area'; row.style.border='none'; row.append(sel, toggle); sheetRoot.append(row, wrap);
      function show(i){
         const t=analysis.themes[i];
         const isLong = document.getElementById('longMode').checked;
         if(isLong) wrap.innerHTML = buildLongSheetHTML(t);
         else wrap.innerHTML = `<article class="qcm-item"><h4>${htmlEscape(t.title||'')}</h4><p>${htmlEscape(t.summaryLong||t.summaryShort||'')}</p></article>`;
      }
      sel.onchange = ()=> show(Number(sel.value));
      sheetRoot.addEventListener('change', (e)=>{ if(e.target && e.target.id==='longMode') show(Number(sel.value)); });
      show(0);
   }
   window.RevisionFlow = {
      attach(analysis, { text='', qcm=[], lowConfidence=[], spaced=[], duration=60 } = {}){
         window.__coach_state = { text, qcm, lowConfidence, spaced, duration };
         mountLongSheetUI(analysis);
         renderFlow(analysis, window.__coach_state);
      },
      update(analysis, stateOverrides={}){
         const next = { ...(window.__coach_state||{}), ...(stateOverrides||{}) };
         window.__coach_state = next;
         renderFlow(analysis, next);
      },
      reset(){
         const stage = document.getElementById('flowStage'); if(stage) stage.innerHTML='';
      }
   };
   document.addEventListener('click', (e)=>{
      const b = e.target.closest('.tab-link'); if(!b || !b.dataset.tab) return;
      const tab = b.dataset.tab;
      document.querySelectorAll('.tab-link').forEach(x=>x.classList.toggle('active', x===b));
      document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active', p.id===tab));
   });
})();

/* ================================
    Guided Reading Engine (Parcours)
    Pourquoi : lecture structurée, plan horaire optimisé, questions courtes et cas pratique par section.
    ================================ */

(() => {
   const $ = (s, r=document) => r.querySelector(s);
   const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
   const flowRoot = $('#flow-output');
   if (!flowRoot) return; // sécurité si onglet absent

   /* ---------- State */
   const state = {
      sections: [],          // [{title, short, medium, long, keyPoints[]}]
      current: 0,
      plan: [],              // [{date,time,duration,sectionIndex}]
      durationMin: 30, breakMin: 10, perDay: 2,
      startTime: '09:00', endTime: '20:00',
      days: ['LU','MA','ME','JE','VE']
   };

   /* ---------- Boot UI wiring */
   const el = {
      generate: $('#gr-generate'), start: $('#gr-start'),
      next: $('#gr-next'), prev: $('#gr-prev'), exportBtn: $('#gr-export'),
      progress: $('#gr-progressbar .bar'), stepper: $('#gr-stepper'),
      title: $('#gr-section-title'),
      vShort: $('#gr-content-short'), vMedium: $('#gr-content-medium'), vLong: $('#gr-content-long'),
      qqList: $('#gr-qq-list'), qqFeedback: $('#gr-qq-feedback'),
      caseBody: $('#gr-case-body'),
      markEasy: $('#gr-mark-easy'), markOk: $('#gr-mark-ok'), markHard: $('#gr-mark-hard'),
      dur: $('#gr-duration'), brk: $('#gr-break'), perDay: $('#gr-sessions-per-day'),
      startT: $('#gr-start-time'), endT: $('#gr-end-time'), days: $('#gr-days'),
      optimize: $('#gr-optimize'), makePlan: $('#gr-make-plan'), planView: $('#gr-plan-view'),
      viewToggles: $$('.view-toggle .btn.seg')
   };

   /* ---------- Helpers */
   function getCourseText() {
      const t = $('#textInput')?.value?.trim();
      return t || '';
   }
   function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
   function setProgress(p){ el.progress.style.width = `${clamp(p,0,100)}%`; }
   function show(seg){ el.vShort.classList.toggle('hidden', seg!=='short');
                                 el.vMedium.classList.toggle('hidden', seg!=='medium');
                                 el.vLong.classList.toggle('hidden', seg!=='long'); }
   function minutesToTimeStr(minutes) {
      const hh = Math.floor(minutes/60).toString().padStart(2,'0');
      const mm = (minutes%60).toString().padStart(2,'0');
      return `${hh}:${mm}`;
   }
   function timeStrToMinutes(hhmm) {
      const [h,m] = (hhmm||'00:00').split(':').map(x=>parseInt(x||'0',10));
      return h*60 + m;
   }

   /* ---------- Parsing & Summaries */
   function parseSectionsHeuristic(text){
      const lines = text.split(/\r?\n/);
      const out = [];
      let cur = { title:'Introduction', body:[] };
      for (const line of lines) {
         const m = line.match(/^(#{1,3})\s+(.+)$/);
         if (m) { if (cur.body.length) out.push({...cur, body:cur.body.join('\n').trim()});
                      cur = { title:m[2].trim(), body:[] }; }
         else cur.body.push(line);
      }
      if (cur.body.length) out.push({...cur, body:cur.body.join('\n').trim()});
      if (out.length>1) return out;
      return text.split(/\n(?=[A-ZÉÈÀÂÎÔÛ0-9][A-ZÉÈÀÂÎÔÛ0-9\s\-:]{3,}\:?\s*$)/m)
         .map((chunk,i)=>{
            const lines = chunk.trim().split('\n');
            let title = (lines[0]||'').replace(/\:$/,'').trim();
            if (i===0 && !/[A-Z]{3,}/.test(title)) title='Introduction';
            return { title, body: lines.slice(1).join('\n').trim() };
         }).filter(s=>s.body?.length) || [{title:'Cours', body:text}];
   }

   function makeSummaries(section){
      const sentences = (section.body||'').split(/(?<=[\.!\?])\s+/).filter(Boolean);
      const bullets = topKeyPoints(section.body, 5);
      const shortHTML = `<h5>Points essentiels<\/h5><ul>${bullets.map(li=>`<li>${escapeHtml(li)}<\/li>`).join('')}<\/ul>`;
      const mediumHTML = `<p>${escapeHtml(sentences.slice(0,6).join(' '))}<\/p>`;
      const longHTML = `<p>${escapeHtml(sentences.slice(0,14).join(' '))}<\/p>`;
      return { shortHTML, mediumHTML, longHTML, keyPoints: bullets };
   }

   function topKeyPoints(text, k=5){
      const lines = text.split(/\n/).map(s=>s.trim()).filter(Boolean);
      if (lines.length>=k) return lines.slice(0,k);
      const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').split(/\s+/);
      const f = Object.create(null);
      for (const w of words){ if (w.length>3) f[w]=(f[w]||0)+1; }
      return Object.entries(f).sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>`Terme clé : ${w}`);
   }

   /* ---------- LLM integration (optional) */
   async function llmSummarizeSections(rawSections){
      try{
         const provider = $('#aiProvider')?.value || 'internal';
         if (!window.__llm_generate || provider==='internal') return null;
         const prompt = {
            role:'system',
            content:[
               'Tu génères pour chaque section 3 niveaux de résumé: bullet court (≤5 points), paragraphe moyen (définitions), long développé (2+ paragraphes).',
               'Réponds JSON strict: [{title, short:["..."], medium:["..."], long:"..."}].'
            ].join(' ')
         };
         const res = await window.__llm_generate({ task:'sheets-3views', prompt, sections: rawSections });
         return Array.isArray(res) ? res : null;
      }catch{ return null; }
   }

   /* ---------- Quick Questions & Case Practice */
   function buildQuickQuestions(sec){
      // Intercept QCM generation and reuse the adaptive generator to ensure identical format
      const strip = (h)=> String(h||'').replace(/<[^>]+>/g,' ');
      const text = strip(sec.longHTML||sec.mediumHTML||sec.shortHTML||'');
      const ensure4 = (opts, ans)=>{
         const seen=new Set(); let out=[];
         for(const o of (opts||[])){
            const v=String(o||'').trim(); if(!v||seen.has(v)) continue; out.push(v); seen.add(v);
         }
         if(ans && !out.includes(ans)) out.unshift(ans);
         const fillers=['Je ne sais pas','Exemple sans définition','Affirmation incorrecte','Réponse incomplète'];
         while(out.length<4){ const f=fillers[out.length%fillers.length]; out.push(seen.has(f)? f+' ' : f); seen.add(f); }
         return out.slice(0,4);
      };
      // 1) Preferred path: same engine as QCM adaptatif
      try{
         if (window.QcmUpgrade && typeof window.QcmUpgrade.generate==='function'){
            const miniAnalysis = {
               themes: [{
                  title: sec.title || 'Section',
                  summaryShort: text,
                  summaryLong: text,
                  raw: text,
                  keywords: (text||'').split(/\s+/).slice(0,12)
               }]
            };
            const proQs = window.QcmUpgrade.generate(miniAnalysis, 3) || [];
            const items = proQs.map(it=>{
               const opts = Array.isArray(it.options)? it.options.slice(0,8): [];
               const correctVal = (typeof it.answer==='number' && opts[it.answer]!=null)
                  ? opts[it.answer]
                  : (typeof it.correct==='string' ? it.correct : (opts[0]||''));
               const options = ensure4(opts, correctVal);
               const answer_index = Math.max(0, options.indexOf(correctVal));
               const explain = (it.explain||it.explanation||'').toString();
               return { q: it.q || it.question || '', options, answer_index, answer_indices: [answer_index], explain };
            }).filter(x=> x.q && x.options.length===4);
            if (items.length) return items.slice(0,3);
         }
      }catch(_){ /* fallback below */ }

      // 2) Legacy fallback: local heuristics (kept for resilience)
      try{
         const s = { title: sec.title || 'section', body: text };
         const gen = (window.NourQuestionGenerator && window.NourQuestionGenerator.generateQuestionsSync)
            ? window.NourQuestionGenerator.generateQuestionsSync(s, { mcq:3, cloze:0, tf:0 })
            : { mcq: [] };
         // derive multiple correct answers when options contain equivalent phrasings
         const norm = (t)=>String(t||'').toLowerCase().normalize('NFD').replace(/[\p{Diacritic}]/gu,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
         const isReject = (t)=>/(je ne sais pas|incorrect|incompl|exemple)/i.test(String(t||''));
         const multiFrom = (opts, idx)=>{
            const out = new Set([idx]);
            const base = norm(opts[idx]||'');
            for(let i=0;i<opts.length;i++){
               if(i===idx) continue; const o=opts[i]; if(isReject(o)) continue;
               const n = norm(o);
               if(!n||n.length<4) continue;
               if(n===base || n.includes(base) || base.includes(n)) out.add(i);
            }
            return [...out];
         };
         const items = (gen.mcq||[]).slice(0,3).map(it=>{
            const ans = (it.options||[])[Number(it.answer_index)||0] || '';
            const options = ensure4(it.options||[], ans);
            const answer_index = Math.max(0, options.indexOf(ans));
            const answer_indices = multiFrom(options, answer_index);
            const explain = (it.explain || it.explanation || it.rationale || '').toString();
            return { q: it.question, options, answer_index, answer_indices, explain };
         });
         if (items.length) return items;
      }catch(_){ /* continue to simple fallback */ }

      // Fallback: heuristic from key points
   const qs = [];
      const kp = sec.keyPoints || [];
      kp.slice(0,3).forEach((p)=>{
         const answer = p.replace(/^Terme clé\s*:\s*/i,'').trim();
         if (answer.length>2){
            const options = ensure4([answer, closeNoise(answer), wrongConcept(answer), 'Je ne sais pas'], answer);
            const answer_index = Math.max(0, options.indexOf(answer));
            const answer_indices = [answer_index];
            const explain = `Indice: la bonne réponse reprend fidèlement le point clé « ${answer} ».`;
            qs.push({ q: `Définis : ${answer}`, options, answer_index, answer_indices, explain });
         }
      });
   if (!qs.length){
         const titleWord = (sec.title||'').split(/\s+/)[0]||'concept';
         const ans = `Définition correcte de ${titleWord}`;
         const options = ensure4([ans, `Exemple sans définition`, `Affirmation incorrecte`, `Je ne sais pas`], ans);
         const answer_index = Math.max(0, options.indexOf(ans));
         const answer_indices = [answer_index];
         const explain = `La bonne option décrit correctement « ${titleWord} » et non un simple exemple.`;
         qs.push({ q:`Qu’est-ce que ${titleWord} ?`, options, answer_index, answer_indices, explain });
      }
      return qs.slice(0,3);
   }

   function buildCasePractice(sec){
      const topic = (sec.title||'le thème').toLowerCase();
      return {
         intro: `Contexte : un étudiant doit appliquer "${topic}" dans une situation réelle.`,
         task: `Tâche : décris les étapes pour résoudre un cas où ${topic} est nécessaire.`,
         criteria: ['Utiliser 2–3 points clés de la section', 'Justifier chaque étape', 'Donner 1 contre-exemple']
      };
   }

   function closeNoise(ans){ return ans.length>6 ? ans.slice(0,ans.length-2) : ans + ' (partiel)'; }
   function wrongConcept(ans){ return ans.split('').reverse().join('').slice(0,Math.max(4,ans.length-3)); }
   function shuffle(a){ return a.map(v=>[v,Math.random()]).sort((x,y)=>x[1]-y[1]).map(x=>x[0]); }
   function escapeHtml(s){return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

   /* ---------- Planification horaire */
   function makeSchedule(){
      const dur = clamp(parseInt(el.dur.value||'30',10), 15, 180);
      const brk = clamp(parseInt(el.brk.value||'10',10), 5, 60);
      const perDay = clamp(parseInt(el.perDay.value||'2',10), 1, 6);
      const start = timeStrToMinutes(el.startT.value||'09:00');
      const end = timeStrToMinutes(el.endT.value||'20:00');
      const days = (el.days.value||'LU,MA,ME,JE,VE').split(',').map(s=>s.trim().toUpperCase());

      state.durationMin = dur; state.breakMin = brk; state.perDay = perDay;
      state.startTime = el.startT.value; state.endTime = el.endT.value; state.days = days;

      const res = [];
      let secIdx = 0;
      const dayNames = ['LU','MA','ME','JE','VE','SA','DI'];
      for (let d=0; d<14 && secIdx < state.sections.length; d++){
         const dayCode = dayNames[d%7];
         if (!days.includes(dayCode)) continue;
         let t = start;
         for (let s=0; s<perDay && secIdx < state.sections.length; s++){
            if (t + dur > end) break;
            res.push({ day: dayCode, time: minutesToTimeStr(t), duration: dur, sectionIndex: secIdx++ });
            t += dur + brk;
         }
      }
      state.plan = res;
      renderPlan(res);
   }

   function optimizeSchedule(){
      el.startT.value = '09:00';
      el.endT.value = '21:00';
      el.perDay.value = '3';
      el.brk.value = '10';
      if (state.sections.length >= 10) el.dur.value = '25';
   }

   function renderPlan(plan){
      el.planView.innerHTML = plan.map(p => `
         <li class="slot">
            <strong>${p.day}<\/strong> <span>${p.time}<\/span>
            <small>(${p.duration} min)<\/small>
            <span>•<\/span>
            <span>Section ${p.sectionIndex+1} — ${escapeHtml(state.sections[p.sectionIndex]?.title||'')}<\/span>
         <\/li>`).map(li=>`<li>${li}<\/li>`).join('');
   }

   /* ---------- Rendering & Navigation */
   function renderStepper(){
      el.stepper.innerHTML = state.sections.map((s,i)=>`
         <span class="step ${i===state.current?'active':''}">#${i+1} ${escapeHtml(s.title||'Section')}<\/span>
      `).join('');
   }

   function renderCurrent(){
      const s = state.sections[state.current];
      if (!s) return;
      el.title.textContent = s.title || `Section ${state.current+1}`;
      el.vShort.innerHTML = s.shortHTML;
      el.vMedium.innerHTML = s.mediumHTML;
      el.vLong.innerHTML = s.longHTML;

      const qq = buildQuickQuestions(s);
   el.qqList.innerHTML = qq.map((it, idx)=>{
         const expected = Array.isArray(it.answer_indices) && it.answer_indices.length ? it.answer_indices : [Number(it.answer_index)||0];
         const multi = expected.length > 1;
         const type = multi ? 'checkbox' : 'radio';
         const hint = multi ? '<div class="hint">Plusieurs réponses possibles<\/div>' : '';
      const explain = it.explain ? `<div class="qq-explain hidden">💡 ${escapeHtml(it.explain)}<\/div>` : '';
      return `
         ${hint}
         <label><input type="${type}" name="qq-${state.current}-${idx}" value="0">${escapeHtml(it.options[0])}<\/label>
         <label><input type="${type}" name="qq-${state.current}-${idx}" value="1">${escapeHtml(it.options[1])}<\/label>
         <label><input type="${type}" name="qq-${state.current}-${idx}" value="2">${escapeHtml(it.options[2])}<\/label>
      <label><input type="${type}" name="qq-${state.current}-${idx}" value="3">${escapeHtml(it.options[3])}<\/label>
      <div class="qcm-meta"><span class="badge">Q${idx+1}<\/span><\/div>
      ${explain}`;
      }).join('<hr style="border:none;border-top:1px dashed var(--border-color);margin:8px 0">');
      // Store expected answers as array of arrays of indices
   el.qqList.dataset.answers = JSON.stringify(qq.map(q=> (Array.isArray(q.answer_indices) && q.answer_indices.length ? q.answer_indices : [Number(q.answer_index)||0])));
   el.qqList.dataset.explain = JSON.stringify(qq.map(q=> q.explain || ''));

      const cs = buildCasePractice(s);
      el.caseBody.innerHTML = `
         <p>${escapeHtml(cs.intro)}<\/p>
         <p><strong>Consigne :<\/strong> ${escapeHtml(cs.task)}<\/p>
         <ul>${cs.criteria.map(c=>`<li>${escapeHtml(c)}<\/li>`).join('')}<\/ul>
      `;

      renderStepper();
      setProgress( ( (state.current+1) / state.sections.length ) * 100 );
      el.prev.disabled = state.current === 0;
      el.next.disabled = state.current >= state.sections.length - 1;
   }

   function move(dir){
      state.current = clamp(state.current + dir, 0, state.sections.length - 1);
      renderCurrent();
   }

   /* ---------- Public actions */
   el.viewToggles.forEach(btn=>{
      btn.addEventListener('click', ()=>{
         el.viewToggles.forEach(b=>b.classList.toggle('selected', b===btn));
         show(btn.dataset.view);
      });
   });

   el.generate?.addEventListener('click', async ()=>{
      const text = getCourseText();
      if (!text) { toast('Collez un cours ou importez un fichier.'); return; }
      const raw = parseSectionsHeuristic(text);
      const llm = await llmSummarizeSections(raw);
      const enriched = (llm && llm.length===raw.length)
         ? raw.map((r,i)=>({
               title: r.title,
               shortHTML: `<h5>Points essentiels<\/h5><ul>${(llm[i].short||[]).slice(0,5).map(x=>`<li>${escapeHtml(x)}<\/li>`).join('')}<\/ul>`,
               mediumHTML: (llm[i].medium||[]).map(p=>`<p>${escapeHtml(p)}<\/p>`).join(''),
               longHTML: `<p>${escapeHtml(llm[i].long||'')}<\/p>`,
               keyPoints: (llm[i].short||[])
            }))
         : raw.map(r => ({ title:r.title, ...makeSummaries(r) }));
      state.sections = enriched;
      state.current = 0;
      makeSchedule();
      renderCurrent();
      toast(`Parcours généré — ${state.sections.length} section(s).`);
   });

   el.start?.addEventListener('click', ()=>{
      if (!state.sections.length){ toast('Génère d’abord le parcours.'); return; }
      state.current = 0;
      state.running = true;
      renderCurrent();
   });

   // --- Minimal Toast (non-bloquant) ---
   const toastHost = document.createElement('div');
   toastHost.id = 'toast-container';
   toastHost.style.position = 'fixed';
   toastHost.style.right = '16px';
   toastHost.style.bottom = '16px';
   toastHost.style.zIndex = '10000';
   toastHost.setAttribute('role','status');
   toastHost.setAttribute('aria-live','polite');
   document.body.appendChild(toastHost);
   function showToast(msg, type='info', ms=2600){
      const t = document.createElement('div');
      t.style.display = 'flex';
      t.style.alignItems = 'center';
      t.style.gap = '8px';
      t.style.marginTop = '8px';
      t.style.padding = '10px 12px';
      t.style.borderRadius = '10px';
      t.style.boxShadow = '0 6px 20px rgba(20,30,58,.12)';
      t.style.background = type==='success' ? '#ecfdf5' : type==='error' ? '#fef2f2' : type==='warn' ? '#fffbeb' : '#f8fafc';
      t.style.border = '1px solid ' + (type==='success' ? '#a7f3d0' : type==='error' ? '#fecaca' : type==='warn' ? '#fde68a' : '#e5e7f2');
      t.style.color = '#111827';
      const icons = window.__nourToastIcons || {
         success: 'assets/nour-sticker-success.png',
         info: 'assets/nour-sticker-info.png',
         warn: 'assets/nour-sticker-warn.png',
         error: 'assets/nour-sticker-error.png'
      };
      const iconUrl = icons[type] || null;
      if (iconUrl) {
         const img = document.createElement('img');
         img.src = iconUrl; img.alt=''; img.width=22; img.height=22; img.style.borderRadius='50%'; img.style.flex='0 0 22px';
         img.onerror = () => { try { img.remove(); } catch(_){} };
         t.appendChild(img);
      }
      const span = document.createElement('span'); span.textContent = String(msg||''); t.appendChild(span);
      toastHost.appendChild(t);
      setTimeout(()=>{ t.style.transition='opacity .25s, transform .25s'; t.style.opacity='0'; t.style.transform='translateY(6px)'; }, Math.max(0, ms-250));
      setTimeout(()=> t.remove(), ms);
   }
   // Expose toast globally for addons
   window.coachToast = showToast;

   // --- Application State ---
   let state = {
      rawText: '',
      analysis: {
         headings: [],
         pedagogicalBlocks: [],
         keyPhrases: [],
         articles: [],
         themes: []
      },
      studySheet: {},
   qcm: [],
   qcmMode: 'pro', // 'pro' (QCM++) or 'classic'
   qcmCount: 12,
   examMode: false,
      srs: [], // Spaced Repetition System items
      chatHistory: [],
      socraticHistory: [],
      currentSession: 'default',
      // Revision Flow
      sessionPlan: {
         durationMin: 45,
         constraints: { qcmPenalty: 1, timeAvailableMin: 45 },
         goals: { themesTarget: 3, scoreTarget: 80, dueDate: null }
      },
      progress: {
         timeSpentMin: 0,
         scores: { qcmCorrect: 0, qcmTotal: 0 },
         srsStability: 0,
         lastReviewedByTheme: {}
      },
      schedulerQueue: [],
      longSheets: []
   };

   // --- Helpers HTTP
   async function fetchJSON(url, opts={}, timeout=8000){
      const ctl = new AbortController(); const id=setTimeout(()=>ctl.abort(), timeout);
      try{
         const res = await fetch(url, { ...opts, signal: ctl.signal });
         clearTimeout(id);
         if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
         return await res.json();
      }catch(e){ clearTimeout(id); throw e; }
   }

   async function getHealth(){
      const tries = [`${API_BASE}/health`, `${API_BASE}/api/health`, `${API_BASE}/v1/health`];
      for (const u of tries){
         try { const j = await fetchJSON(u, {}, 3000); if (j && (j.status==='ok' || j.ok===true)) return j; } catch {}
      }
      return null;
   }
   async function healthCheck(){
      const j = await getHealth();
      return !!j;
   }
   async function internalReady(){
      const j = await getHealth();
      return !!(j && j.llm && j.llm.ready === true);
   }

   // ---- Adaptateurs de providers
   const Providers = {
      internal: {
         name:'IA Interne',
         async chat({messages, context}) {
            // Appel strict à l’API interne; tente plusieurs URLs locales
            const prompt = messages.map(m=>`${m.role}: ${m.content}`).join('\n');
            const payload = { prompt, provider: 'internal' };
            if (context && context.trim()) payload.context = context.slice(0, 8000);
            const urls = [
              'http://127.0.0.1:8000/api/chat',
              'http://localhost:8000/api/chat',
              `${API_BASE}/api/chat`
            ];
            for (const url of urls){
               try{
                  const j = await fetchJSON(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }, 12000);
                  const reply = j.reply || j.output || j.answer || j.text || '';
                  if (reply) return reply;
               }catch(_){ /* try next url */ }
            }
            // Fallback heuristique si l'API interne est indisponible
            const last = messages.filter(m=>m.role==='user').slice(-1)[0]?.content || '';
            const ctx = (context || ($('#textInput')?.value || '')).slice(0, 2000);
            return [
               'Je n’ai pas accès à l’IA interne pour le moment.',
               ctx ? `• Contexte détecté (${Math.min(ctx.length,2000)} car.)` : '• Aucun cours fourni pour le contexte.',
               last ? `• Votre question : « ${last.slice(0,240)} »` : '',
               '• Démarrez le serveur local (Make run) et vérifiez l’état dans Paramètres.',
            ].filter(Boolean).join('\n');
         }
      },
      openai: {
         name:'OpenAI',
         async chat({messages, model, context}) {
            const key = store.apiKey;
            if (!key) throw new Error('Clé API manquante.');
            const mdl = model || store.model || 'gpt-4o-mini';
            const msgs = context ? [{role:'system', content:`Contexte:\n${context}`} , ...messages] : messages;
            // Prefer backend relay to avoid browser CORS
            try{
               if (await healthCheck()){
                  const body = {
      let idx=0, out=[];
      const themes=analysis?.themes||[];
      const sents=themes.flatMap(t=> splitS(t.raw||t.summaryLong||t.summaryShort||'').map(s=>({s,t})) ).filter(x=>x.s.length>40).slice(0,120);
      const all=sents.map(x=>x.s), allKw=uniq(themes.flatMap(t=>t.keywords||[]));
      for(const t of themes){
         const blocks=t.blocks||[];
         const def=blocks.find(b=>/définition/i.test(b.type||''))?.content;
         if(def && out.length<target){
            let opts=shuffle(uniq([def, t.summaryShort, sliceWords(t.summaryLong||'',25), sliceWords(all[0]||'',20)]));
            opts=antiOverlapOptions(opts, def);
            out.push({id:'qd'+(idx++),type:'definition',q:`Quelle est la bonne définition de « ${t.title} » ?`,options:opts,answer:opts.indexOf(def),explain:`Source: ${sliceWords(def,20)}…`});
         }
         const exc=(t.blocks||[]).find(b=>/exception/i.test(b.type||''))?.content;
         if(exc && out.length<target){
            const wrong=(t.blocks||[]).filter(b=>/principe|jurisprudence/i.test(b.type||'')).map(b=>b.content);
            let opts=shuffle(uniq([exc,...wrong,sliceWords(t.summaryLong||'',20)]));
            opts=antiOverlapOptions(opts, exc);
            out.push({id:'qe'+(idx++),type:'exception',q:`Laquelle est une exception liée à « ${t.title} » ?`,options:opts,answer:opts.indexOf(exc)});
         }
         const juris=(t.blocks||[]).find(b=>/jurisprudence/i.test(b.type||''))?.content;
         if(juris && out.length<target){
            let opts=shuffle(uniq([juris,sliceWords(t.summaryLong||'',20),sliceWords(all[1]||'',20),sliceWords(all[2]||'',20)]));
            opts=antiOverlapOptions(opts, juris);
            out.push({id:'qj'+(idx++),type:'juris',q:`Quelle mention correspond à la jurisprudence clé ?`,options:opts,answer:opts.indexOf(juris)});
         }
      }
      for(const {s,t} of sents){ if(out.length>=target) break; const q=buildFactMCQPro(s,t.keywords||[],idx++,all,allKw); if(q){ q.options=antiOverlapOptions(q.options, q.options[q.answer]); out.push(q); } }
      const arts=uniq(themes.flatMap(t=>extractArticlesPro(t.raw||'')));
      for(const art of arts){ if(out.length>=target) break; const host=sents.find(x=>x.s.includes(art)); if(host){ const q=buildArticleMCQPro(host.s,art,idx++); if(q){ q.options=antiOverlapOptions(q.options, q.options[q.answer]); out.push(q); } } }
      return out.slice(0,target);
   }
   function renderQcmInline(root, qs){
      root.innerHTML='';
      qs.forEach((q,qi)=>{
         // Support single answer (number or string) and multi-answers (array of indices or strings)
         let options = q.options||[];
         let correctSet = new Set();
         if (Array.isArray(q.answers)) {
            // answers as indices or strings
            const arr = q.answers;
            arr.forEach(a=>{
               if (typeof a==='number' && options[a]!=null) correctSet.add(options[a]);
               else if (typeof a==='string') correctSet.add(a);
            });
         } else if (Array.isArray(q.answer_indices)) {
            q.answer_indices.forEach(i=>{ if (typeof i==='number' && options[i]!=null) correctSet.add(options[i]); });
         } else if (typeof q.answer==='number') {
            if (options[q.answer]!=null) correctSet.add(options[q.answer]);
         } else if (typeof q.correct==='string') {
            correctSet.add(q.correct);
         } else if (options[0]!=null) {
            correctSet.add(options[0]);
         }
         // sanitize options against overlap with known correct
         const anyCorrect = [...correctSet][0] || '';
         let opts = antiOverlapOptions(options, anyCorrect);
         opts = shuffle(opts);
         const correctVals = new Set([...correctSet].map(v=>v));
         const div=document.createElement('div'); div.className='qcm-item';
         const name = `inlineq_${qi}`;
         const multi = correctVals.size>1;
         div.innerHTML=`<p><strong>Q${qi+1}.</strong> ${q.q}${multi? ' <em>(plusieurs réponses possibles)</em>':''}</p>
            <div class="qcm-options">
              ${opts.map((o,i)=>`<label data-i="${i}"><input type="${multi?'checkbox':'radio'}" name="${name}" value="${i}"> ${o}</label>`).join('')}
            </div>
            <div class="feedback hidden"></div>`;
         root.appendChild(div);
         const finish = ()=>{
            if(div.dataset.done) return;
            const fb=div.querySelector('.feedback');
            const picked = [...div.querySelectorAll('input')].filter(x=>x.checked).map(x=> Number(x.value));
            const pickedVals = new Set(picked.map(i=> opts[i]));
            const allCorrect = (pickedVals.size===correctVals.size) && [...pickedVals].every(v=> correctVals.has(v));
            div.dataset.done=1;
            if(allCorrect){ fb.className='feedback correct'; fb.textContent='✔️ Correct'; }
            else {
               fb.className='feedback incorrect';
               const sol = opts.filter(o=> correctVals.has(o)).join(' • ');
               fb.textContent=`❌ Incorrect. Réponse(s): ${sol}`; q.due=Date.now()+24*60*60*1000;
            }
            fb.classList.remove('hidden');
         };
         div.querySelectorAll('label').forEach(l=>l.addEventListener('click',e=>{
            // For radio, finish immediately; for checkbox, wait until at least one is checked and a second click also finishes
            if(div.dataset.done) return;
            const isRadio = l.querySelector('input')?.type==='radio';
            if(isRadio) return finish();
            const chosen = div.querySelectorAll('input:checked').length;
            if(chosen>=1){ /* require at least one; user can click any label to validate */ }
         }));
         // Add a small validate button for multi to avoid accidental early check
         if(correctVals.size>1){ const b=document.createElement('button'); b.className='btn'; b.textContent='Valider'; b.onclick=finish; div.appendChild(b); }
      });
   }
   function countdown(ms, container){
      const el=document.createElement('div'); el.style.opacity='.7'; el.style.fontFamily='monospace'; container.appendChild(el);
      const tick=()=>{ if(ms<=0){ el.textContent='⏱️ temps écoulé'; return; } el.textContent=`⏱️ ${Math.ceil(ms/60000)} min restantes`; ms-=30000; setTimeout(tick,30000); };
      tick(); return ()=> el.remove();
   }
   function buildSessionPlan(analysis, durationMin=60, lowConfidence=new Set(), spaced=[]){
      const themes=analysis.themes||[];
      const score=t=> (lowConfidence.has(t.title)?2:0) + Math.min(3, spaced.filter(q => ((q.due||0)<=Date.now()) && (((q.explain||'').toLowerCase().includes((t.title||'').toLowerCase()))||((q.q||'').toLowerCase().includes((t.title||'').toLowerCase())))).length);
      const order=themes.map((t,i)=>({i,sc:score(t)})).sort((a,b)=>b.sc-a.sc).map(x=>x.i);
      const pick=order.slice(0, Math.max(2, Math.floor(durationMin/20)));
      const perTheme=Math.max(6, Math.floor(durationMin/(3*Math.max(2,pick.length||1))));
      const steps=[{type:'diagnostic',size:5}];
      for(const i of pick){ steps.push({type:'learn',theme:i,minutes:perTheme}); steps.push({type:'practice',theme:i,size:4}); steps.push({type:'recall',theme:i,prompts:3}); }
      steps.push({type:'test',size:8});
      return steps;
   }
   function renderStepLabel(analysis,s){
      const t=i=> (analysis.themes[i]?.title||'').replace(/</g,'&lt;');
      if(s.type==='diagnostic') return `<li>Diagnostic (QCM ×${s.size})</li>`;
      if(s.type==='learn') return `<li>Apprentissage – ${t(s.theme)} (${s.minutes} min)</li>`;
      if(s.type==='practice') return `<li>Pratique QCM – ${t(s.theme)} (×${s.size})</li>`;
      if(s.type==='recall') return `<li>Rappel actif – ${t(s.theme)} (3 réponses ouvertes)</li>`;
      if(s.type==='test') return `<li>Test final (×${s.size})</li>`; return `<li>${s.type}</li>`;
   }
   function startFlow(analysis,{duration=60,lowConfidence=new Set(),spaced=[]}={}){
      const host=document.getElementById('flow-output'); if(!host) return;
      let steps=buildSessionPlan(analysis,duration,lowConfidence,spaced);
      // Controls bar with duration and Pomodoro toggle + live display
      host.innerHTML = `
         <div class="chat-input-area" style="gap:8px; border:none; align-items:center">
            <label>Durée
               <select id="flowDurationSel" class="input" style="min-width:120px; margin-left:6px">
                  <option value="30" ${duration===30?'selected':''}>30 min</option>
                  <option value="60" ${duration===60?'selected':''}>1 h</option>
                  <option value="120" ${duration===120?'selected':''}>2 h</option>
                  <option value="180" ${duration===180?'selected':''}>3 h</option>
               </select>
            </label>
            <label style="display:flex; align-items:center; gap:6px">
               <input type="checkbox" id="pomodoroToggle"> Pomodoro 25/5
            </label>
            <div id="totalTimeDisplay" class="badge" title="Temps total restant" style="margin-left:auto">Temps restant: —</div>
            <div id="pomoDisplay" class="badge">Pomodoro désactivé</div>
            <button id="pomoPause" class="btn" disabled>Pause</button>
            <button id="pomoReset" class="btn" disabled>Réinitialiser</button>
         </div>
         <ol class="plan">${steps.map(s=>renderStepLabel(analysis,s)).join('')}</ol>
         <button id="startFlow" class="btn primary">Démarrer</button>
         <div id="flowStage" style="margin-top:10px"></div>`;

   const sel = document.getElementById('flowDurationSel');
   // Load saved prefs
   try{ const p=JSON.parse(localStorage.getItem('coach_parcours_prefs')||'{}'); if(p.duration){ sel.value=String(p.duration); steps=buildSessionPlan(analysis, Number(p.duration), lowConfidence, spaced); const plan=host.querySelector('ol.plan'); if(plan) plan.innerHTML=steps.map(s=>renderStepLabel(analysis,s)).join(''); } if(p.pomodoro){ const t=document.getElementById('pomodoroToggle'); if(t){ t.checked=!!p.pomodoro; } } }catch(_){ }
      sel.onchange = ()=>{
         const val = Number(sel.value||duration||60);
         steps = buildSessionPlan(analysis, val, lowConfidence, spaced);
         const plan = host.querySelector('ol.plan'); if(plan) plan.innerHTML = steps.map(s=>renderStepLabel(analysis,s)).join('');
      try{ const p=JSON.parse(localStorage.getItem('coach_parcours_prefs')||'{}'); p.duration=val; localStorage.setItem('coach_parcours_prefs', JSON.stringify(p)); }catch(_){ }
      };

      // Pomodoro engine
      const pomo = { state:'idle', mode:'focus', remaining:0, timer:null, cycles:0, enabled:false };
      const pomoDisplay = document.getElementById('pomoDisplay');
   const pomoToggle = document.getElementById('pomodoroToggle');
      const btnPause = document.getElementById('pomoPause');
      const btnReset = document.getElementById('pomoReset');
      const FOCUS_SEC = 25*60, BREAK_SEC = 5*60;
      const totalDisplay = document.getElementById('totalTimeDisplay');
      let totalRemainingSec = 0, totalTimer = null, flowDone = false;
      function fmtHMS(sec){ const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60; return h>0? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`; }
      function updateTotal(){ if(totalDisplay){ totalDisplay.textContent = `Temps restant: ${totalRemainingSec>0? fmtHMS(totalRemainingSec) : 'Terminé'}`; } }
      function startTotalTimer(){ if(totalTimer) clearInterval(totalTimer); updateTotal(); totalTimer = setInterval(()=>{ if(flowDone) return; if(totalRemainingSec>0){ totalRemainingSec--; updateTotal(); } }, 1000); }
      // Floating mini-timer pill
      let pillHidden = false; let pillEl = document.querySelector('.pomo-pill');
      if(!pillEl){ pillEl = document.createElement('div'); pillEl.className='pomo-pill'; pillEl.innerHTML = '<span class="dot"></span><span class="txt">Focus 25:00</span><button class="close btn" aria-label="Masquer">×</button>';
         document.body.appendChild(pillEl);
         pillEl.querySelector('.close').onclick = (e)=>{ e.stopPropagation(); pillHidden=true; pillEl.classList.remove('is-visible'); };
         pillEl.onclick = ()=>{ if(!pomo.enabled) return; btnPause.click(); };
      }
      function updatePill(){ if(!pillEl) return; if(!pomo.enabled || pillHidden || flowDone){ pillEl.classList.remove('is-visible'); return; } pillEl.classList.toggle('is-visible', pomo.state==='running'); const dot=pillEl.querySelector('.dot'); const txt=pillEl.querySelector('.txt'); if(dot) dot.style.background = pomo.mode==='focus'? '#22c55e' : '#60a5fa'; if(txt) txt.textContent = `${pomo.mode==='focus'?'Focus':'Pause'} ${fmt(Math.max(0,pomo.remaining||0))}`; }
      // Notifications + sound
      function ensureNotify(){ try{ if('Notification' in window && Notification.permission==='default'){ Notification.requestPermission().catch(()=>{}); } }catch(_){}
      }
      function notify(title, body){ try{ if('Notification' in window && Notification.permission==='granted'){ new Notification(title,{ body }); } }catch(_){}
         try{ const Ctx = window.AudioContext||window.webkitAudioContext; if(!Ctx) return; const ctx = new Ctx(); const o=ctx.createOscillator(); const g=ctx.createGain(); o.type='sine'; o.frequency.value=880; o.connect(g); g.connect(ctx.destination); const t=ctx.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t+0.02); g.gain.exponentialRampToValueAtTime(0.0001, t+0.25); o.start(t); o.stop(t+0.28); }catch(_){}
      }
      const fmt = (sec)=>{
         const m=Math.floor(sec/60), s=sec%60; return `${m}:${String(s).padStart(2,'0')}`;
      };
      function renderPomo(){
         if(!pomo.enabled){ pomoDisplay.textContent='Pomodoro désactivé'; btnPause.disabled=true; btnReset.disabled=true; return; }
         const label = pomo.mode==='focus'? 'Focus' : 'Pause';
         pomoDisplay.textContent = `${label} ${fmt(Math.max(0,pomo.remaining||0))}`;
         btnPause.disabled = (pomo.state!=='running');
         btnReset.disabled = (pomo.state==='idle');
         updatePill();
      }
      function stopTimer(){ if(pomo.timer){ clearInterval(pomo.timer); pomo.timer=null; } pomo.state='paused'; renderPomo(); }
   let advanceStep = null; // assigned when flow runs
   function startTick(){ if(pomo.timer) clearInterval(pomo.timer); pomo.state='running'; pomo.timer=setInterval(()=>{
            pomo.remaining = Math.max(0, (pomo.remaining||0)-1); renderPomo();
            if(pomo.remaining<=0){
               clearInterval(pomo.timer); pomo.timer=null;
               if(pomo.mode==='focus'){
                  // Switch to break automatically
                  pomo.mode='break'; pomo.remaining=BREAK_SEC; pomo.state='running'; renderPomo();
                  notify('Focus terminé','Prenez 5 minutes de pause.');
                  startTick();
               } else { // break finished -> advance step and start next focus
                  pomo.mode='focus'; pomo.remaining=FOCUS_SEC; pomo.state='paused'; pomo.cycles++;
                  renderPomo();
                  notify('Pause terminée','On reprend !');
                  // Auto-advance to next step if possible
                  if(advanceStep) advanceStep();
               }
            }
         }, 1000);
      }
      function startFocus(){ pomo.enabled = pomoToggle.checked; if(!pomo.enabled){ renderPomo(); return; } pomo.mode='focus'; pomo.remaining = FOCUS_SEC; startTick(); renderPomo(); }
      btnPause.onclick = ()=>{ if(pomo.state==='running'){ stopTimer(); btnPause.textContent='Reprendre'; } else if(pomo.enabled){ pomo.state='running'; startTick(); btnPause.textContent='Pause'; } };
      btnReset.onclick = ()=>{
         if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; pomo.mode='focus'; pomo.remaining=0; flowDone=false; pillHidden=false; updatePill(); renderPomo(); btnPause.textContent='Pause';
      };
   pomoToggle.onchange = ()=>{ pomo.enabled = pomoToggle.checked; if(pomo.enabled) ensureNotify(); if(!pomo.enabled){ if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; } try{ const p=JSON.parse(localStorage.getItem('coach_parcours_prefs')||'{}'); p.pomodoro=!!pomo.enabled; localStorage.setItem('coach_parcours_prefs', JSON.stringify(p)); }catch(_){ } renderPomo(); };
      renderPomo();

   document.getElementById('startFlow').onclick=()=>{
         let i=0; const stage=document.getElementById('flowStage');
         // Init total remaining time and UI
         const selNow = document.getElementById('flowDurationSel'); totalRemainingSec = Math.max(0, Number(selNow && selNow.value || duration || 60) * 60); flowDone=false; startTotalTimer(); ensureNotify(); pillHidden=false; updatePill();
         function doStep(){
            if(i>=steps.length){ stage.innerHTML='<div class="qcm-item" style="border-left:4px solid var(--success-color)">Session terminée 🎉</div>'; flowDone=true; if(totalTimer){ clearInterval(totalTimer); totalTimer=null; } updateTotal(); updatePill(); return; }
            stage.innerHTML=''; const s=steps[i];
      // highlight active step
      const li = host.querySelectorAll('ol.plan li')[i]; host.querySelectorAll('ol.plan li').forEach(x=>x.classList.remove('active')); if(li) li.classList.add('active');
            // If Pomodoro is on, start a fresh focus; otherwise use per-step countdown
            if(pomo.enabled){ startFocus(); } else if(s.minutes){ countdown(s.minutes*60*1000,stage); }
            if(s.type==='learn'){
               const t=analysis.themes[s.theme]; stage.innerHTML+=`<div class="qcm-item"><h3>${t.title||''}</h3><p>${(t.summaryLong||t.summaryShort||'').replace(/</g,'&lt;')}</p></div>`;
               const nxt=document.createElement('button'); nxt.className='btn'; nxt.textContent='Suivant'; nxt.onclick=()=>{ i++; doStep(); if(pomo.enabled){ // reset focus for next step
                     if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; startFocus(); }
               }; stage.appendChild(nxt);
            }else if(s.type==='practice'){
               const qs=genQCMPro({themes:[analysis.themes[s.theme]]}, s.size); const box=document.createElement('div'); stage.appendChild(box); renderQcmInline(box, qs);
               const gate=document.createElement('div'); gate.className='qcm-item'; stage.appendChild(gate);
               const btn=document.createElement('button'); btn.className='btn'; btn.textContent='Valider étape'; btn.disabled=true; stage.appendChild(btn);
               const refresh=()=>{ const done=[...box.querySelectorAll('.qcm-item')].filter(x=>x.dataset.done).length; gate.textContent=`Progression: ${done}/${qs.length}`; btn.disabled=done<qs.length; };
               const mo=new MutationObserver(refresh); mo.observe(box,{subtree:true,attributes:true,attributeFilter:['data-done']}); refresh();
               btn.onclick=()=>{ mo.disconnect(); i++; doStep(); if(pomo.enabled){ if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; startFocus(); } };
            }else if(s.type==='recall'){
               const t=analysis.themes[s.theme];
               stage.innerHTML+=`<div class="qcm-item"><h3>Rappel actif – ${t.title||''}</h3>
                  <p><b>Définition :</b><br><textarea placeholder="Votre réponse..."></textarea></p>
                  <p><b>Exception :</b><br><textarea placeholder="Votre réponse..."></textarea></p>
                  <p><b>Cas pratique bref :</b><br><textarea placeholder="Votre réponse..."></textarea></p></div>`;
               const nxt=document.createElement('button'); nxt.className='btn'; nxt.textContent='Suivant'; nxt.onclick=()=>{ i++; doStep(); if(pomo.enabled){ if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; startFocus(); } }; stage.appendChild(nxt);
            }else{ // diagnostic / test
               const qs=genQCMPro(analysis, s.size); const box=document.createElement('div'); stage.appendChild(box); renderQcmInline(box, qs);
               const gate=document.createElement('div'); gate.className='qcm-item'; stage.appendChild(gate);
               const btn=document.createElement('button'); btn.className='btn'; btn.textContent='Valider étape'; btn.disabled=true; stage.appendChild(btn);
               const refresh=()=>{ const done=[...box.querySelectorAll('.qcm-item')].filter(x=>x.dataset.done).length; gate.textContent=`Progression: ${done}/${qs.length}`; btn.disabled=done<qs.length; };
               const mo=new MutationObserver(refresh); mo.observe(box,{subtree:true,attributes:true,attributeFilter:['data-done']}); refresh();
               btn.onclick=()=>{ mo.disconnect(); i++; doStep(); if(pomo.enabled){ if(pomo.timer) clearInterval(pomo.timer); pomo.timer=null; pomo.state='idle'; startFocus(); } };
            }
         }
         // Allow Pomodoro to auto-advance after a completed break
         advanceStep = ()=>{ i++; doStep(); };
         doStep();
      };
   }
   window.QcmUpgrade={ generate: genQCMPro };
   window.RevisionFlow = Object.assign(window.RevisionFlow||{}, { start: startFlow });
})();

   // /script.js — AJOUT : Chat flottant "Professeur Nour"
   (() => {
      const $ = (s, r=document) => r.querySelector(s);
      const nourFab = $('#nour-fab');
      const nourChat = $('#nour-chat');
      const wrap = $('#nour-chat-messages');
      const input = $('#nour-chat-input');
      const sendBtn = $('#nour-chat-send');
      const btnMin = $('#nour-min');
      const btnClose = $('#nour-close');
   const nudge = $('#nour-nudge');

      if (!nourFab || !nourChat) return;

      function appendMsg(text, role='assistant'){
         const m = document.createElement('div');
         m.className = `chat-message ${role==='user'?'user-message':'assistant-message prof-nour'}`;
         m.textContent = text;
         wrap.appendChild(m);
         wrap.scrollTop = wrap.scrollHeight;
      }

      function greetOnce(){
         if (wrap.dataset.greeted === '1') return;
         appendMsg('Bonjour, je suis Professeur Nour. Comment puis-je vous aider ?','assistant');
         wrap.dataset.greeted = '1';
      }

      function showChat(open=true){
         nourChat.classList.toggle('hidden', !open);
         nourFab.setAttribute('aria-expanded', String(open));
         if (open) { input && input.focus(); greetOnce(); }
         if (open && nudge) nudge.classList.add('hidden');
      }

   async function respondTo(text){
         try{
            if (typeof window.__llm_generate === 'function'){
               const res = await window.__llm_generate({
         task: 'grounded-chat',
         prompt: 'Tu es Professeur Nour, un professeur bienveillant. Jeu de rôle: réponds comme un prof, en français, très clair, structuré en 2-4 phrases max, propose une petite question de vérification à la fin.',
                  question: text
               });
               const answer = (res && (res.answer || res.text)) || String(res||'');
               appendMsg(`Professeur Nour : ${answer || 'Je réfléchis à la meilleure explication pour vous.'}`,'assistant');
            } else {
         // Fallback local: court, contextualisé, avec question de vérification
         const t = (text||'').toLowerCase();
         const intents = {
            def: /qu['’]est-ce|definition|définition|signifie|c[’']est quoi/,
            plan: /plan|organiser|planning|horaire|réviser|révision/,
            qcm: /qcm|quiz|question|choix/,
            ex: /exemple|cas|pratique/,
            compare: /diff[ée]rence|vs|contraire|oppos/,
            law: /article|jurisprudence|arr[êe]t|loi/
         };
         const pick = (arr)=> arr[Math.floor(Math.random()*arr.length)];
         let reply = '';
         if (intents.plan.test(t)) {
            reply = pick([
               "Pour t'organiser, vise des sessions de 25–40 min avec 5–10 min de pause. Commence par un thème clé, puis 3–5 QCM. Question: combien de minutes veux-tu consacrer aujourd’hui?",
               "On va structurer: lecture courte, 4 QCM, puis rappel actif. Question: tu préfères des sessions de 30 ou 45 minutes?"
            ]);
         } else if (intents.qcm.test(t)) {
            reply = pick([
               "Je propose 4 options par question, 1 correcte et 3 distracteurs plausibles. Question: veux-tu un lot de 10 QCM ou commencer par 6?",
               "On peut générer des QCM ciblés par thème avec justification courte. Question: quel chapitre souhaites-tu travailler?"
            ]);
         } else if (intents.ex.test(t)) {
            reply = pick([
               "Exemple: applique la notion à un cas bref et identifie 1 exception. Question: veux-tu que je crée un mini-cas sur ton chapitre?",
               "On peut illustrer via un micro-cas en 3 étapes (contexte, règle, exception). Question: quel concept vises-tu?"
            ]);
         } else if (intents.compare.test(t)) {
            reply = pick([
               "Compare les définitions, le rôle et un exemple pour chacun. Question: souhaites-tu un tableau de différences rapide?",
               "On distingue par cause/conséquence, conditions et effets. Question: quelles notions veux-tu opposer?"
            ]);
         } else if (intents.law.test(t)) {
            reply = pick([
               "Repère l'article, son alinéa et la jurisprudence clé. Question: de quel article parles-tu?",
               "On cite l'article exact et 1 arrêt illustratif. Question: as-tu un numéro d'article à analyser?"
            ]);
         } else if (intents.def.test(t)) {
            reply = pick([
               "Donne une définition concise (1 phrase) + 1 exemple. Question: quel terme dois-je définir?",
               "On définit d'abord, puis on précise le rôle et une exception. Question: quel concept vises-tu?"
            ]);
         } else {
            reply = pick([
               "Précise le chapitre ou colle un extrait pour une aide ciblée. Question: quel thème veux-tu travailler d'abord?",
               "Je peux t'aider à clarifier un point précis. Question: veux-tu des QCM, un plan ou un exemple?"
            ]);
         }
         appendMsg('Professeur Nour : ' + reply,'assistant');
            }
         }catch(e){
            appendMsg('Professeur Nour : petite panne technique, réessayez dans un instant.','assistant');
         }
      }

      function onSend(){
         const val = (input && input.value.trim()) || '';
         if (!val) return;
         appendMsg(val, 'user');
         if (input) input.value = '';
         respondTo(val);
      }

      nourFab.addEventListener('click', () => showChat(nourChat.classList.contains('hidden')));
      btnClose && btnClose.addEventListener('click', () => showChat(false));
      btnMin && btnMin.addEventListener('click', () => showChat(false));
      sendBtn && sendBtn.addEventListener('click', onSend);
      input && input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); onSend(); } });

   // Nudge appear once a few seconds after load
   setTimeout(()=>{ try{ if(nudge && !localStorage.getItem('coach_nudge_seen')){ nudge.classList.remove('hidden'); } }catch(_){} }, 1200);
   nudge?.querySelector('.nudge-close')?.addEventListener('click', ()=>{ nudge.classList.add('hidden'); try{ localStorage.setItem('coach_nudge_seen','1'); }catch(_){} });
   // Clicking the nudge opens chat
   nudge?.addEventListener('click', (e)=>{ if(e.target.closest('.nudge-close')) return; showChat(true); try{ localStorage.setItem('coach_nudge_seen','1'); }catch(_){} });
   })();

// ===== Mascotte logic (append-only) =====
(()=>{
   const $ = (s,r=document)=>r.querySelector(s);
   const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

   // Masquer l'écran vide dès qu'on lance une analyse
   on($('#processBtn'), 'click', () => $('#analysis-empty')?.classList.add('hidden'));

   // Si du texte est collé directement, on masque aussi
   on($('#textInput'), 'input', () => {
      if (($('#textInput').value || '').trim().length > 0) $('#analysis-empty')?.classList.add('hidden');
   });

   // Afficher le tip QCM quand on ouvre l'onglet QCM
   document.addEventListener('click', (e) => {
      const t = e.target.closest('.tab-link');
      if (t?.dataset.tab === 'qcm') $('#qcm-tip')?.classList.remove('hidden');
   });
})();

   // Toggle global d'interface : cache la colonne gauche et étire tous les onglets
   (() => {
      const btn = document.getElementById('toggleWide');
      if (!btn) return;
      const apply = (on) => {
         document.body.classList.toggle('layout-wide', on);
         try { localStorage.setItem('layout_wide', on ? '1' : '0'); } catch(_) {}
         btn.textContent = on ? '↔️ Réduire' : '↔️ Étendre';
         document.querySelector('.tabs')?.scrollIntoView({ block:'nearest' });
      };
   // Default to wide across all tabs unless user previously disabled it
   apply((() => { try { const v = localStorage.getItem('layout_wide'); return v ? v === '1' : true; } catch(_) { return true; } })());
      btn.addEventListener('click', () => apply(!document.body.classList.contains('layout-wide')));
   })();