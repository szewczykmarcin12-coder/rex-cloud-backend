import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Calendar, Home, Clock, Menu, X, ChevronLeft, ChevronRight, LogOut, Info, Cloud, MapPin, Search, Briefcase, RefreshCw, Users, Lock } from 'lucide-react';

// ===================== CONFIG =====================
const API_BASE = 'https://rex-cloud-backend.vercel.app/api';
// ^ Zmień na URL swojego backendu po wdrożeniu

const DEFAULT_LOCATION = 'Popeyes PLK Kraków Galeria Krakowska';

const colors = {
  primary: { darkest: '#12423f', dark: '#315f5b', medium: '#59807c', light: '#96aaa9', bg: '#dfe6e5', bgLight: '#f4f7f6' },
  accent: { dark: '#101815', medium: '#2A3B37', light: '#59807c', bg: '#EDF1EF' }
};

// Station color palette (matches Excel matrix sections)
const stationColors = {
  'PANIEROWANIE': '#7CB342', 'SMAŻENIE': '#E74C3C', 'KANAPKI / WRAPY': '#00A3E0',
  'KONTROLER': '#2F5D8A', 'WSPARCIE WIECZORNE / FLEX': '#9C27B0', 'DISPATCHER': '#FF7043',
  'PHU': '#00897B', 'DESERY / NAPOJE': '#EC407A', 'FRYTKI': '#FBC02D', 'ZMYWAK': '#64748B',
  'PREP': '#8D6E63', 'DOSTAWA': '#5C6BC0', 'MANAGER': '#12423f', 'MGR FUNKCYJNE': '#455A64',
  'SZKOLENIA': '#26A69A', 'TRAINING': '#26A69A', 'INSTRUKTOR': '#00796B'
};
const stationColor = (s) => stationColors[(s || '').toUpperCase()] || colors.primary.medium;
const rolaSzk = (s) => {
  const r = (s.rola || '').toLowerCase();
  if (r === 'instruktor' || r === 'training') return r;
  const st = (s.station || '').toLowerCase();
  if (st === 'instruktor' || st === 'training') return st;
  return null;
};
// Etykieta pozycji — stare dane 'training'/'instruktor' pokazują "Szkolenie"
const nazwaStanowiska = (s) => {
  const u = (s.station || '').toLowerCase();
  if (u === 'training') return 'Szkolenie';
  if (u === 'instruktor') return s.szkoli && s.station && u !== 'instruktor' ? s.station : 'Szkolenie (instruktor)';
  return s.szkoli ? `${s.station} · szkoli` : s.station;
};

// ── Scalanie zmian szkoleniowych ──
// Instruktor ma w grafiku DWA wiersze na te same godziny: stację roboczą (np. KONTROLER)
// i równoległy wiersz "instruktor". W aplikacji pokazujemy to jako JEDNĄ zmianę
// z dopiskiem o szkoleniu — dzięki temu nic się nie nakłada, a godziny liczą się raz.
const minOf = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const nachodza = (a, b) => {
  let a1 = minOf(a.start), a2 = minOf(a.end); if (a2 <= a1) a2 += 1440;
  let b1 = minOf(b.start), b2 = minOf(b.end); if (b2 <= b1) b2 += 1440;
  return a1 < b2 && b1 < a2;
};
const scalZmiany = (arr) => {
  const zwykle = [], instr = [];
  (arr || []).forEach((s) => (rolaSzk(s) === 'instruktor' ? instr : zwykle).push(s));
  const out = zwykle.map((s) => ({ ...s }));
  instr.forEach((i) => {
    const para = out.find((s) => s.date === i.date && nachodza(s, i));
    if (para) { para.szkoli = true; para.partnerSzk = i.partner || i.uczen || null; }   // dopisek na istniejącej zmianie
    else out.push({ ...i, szkoli: true, station: i.station });  // instruktor bez pary — pokaż raz
  });
  return out;
};

const paraLabel = (shift) => {
  if (shift.szkoli) return { rola: 'Szkolisz tego dnia', osoba: shift.partnerSzk || '' };
  const r = rolaSzk(shift);
  if (!r) return null;
  return r === 'instruktor'
    ? { rola: 'Szkolenie · szkoli', osoba: shift.partner || '' }
    : { rola: 'Szkolenie · instruktor', osoba: shift.partner || '' };
};

const monthNames = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
const monthNamesGen = ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia'];
const dniPelne = ['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'];
const dayNames = ['PON','WT','ŚR','CZW','PT','SOB','NIEDZ'];
const dayShort = ['NIEDZ','PON','WT','ŚR','CZW','PT','SOB'];

const saveToStorage = (k, d) => { try { localStorage.setItem(k, JSON.stringify(d)); } catch {} };
const loadFromStorage = (k, def = null) => { try { const d = localStorage.getItem(k); return d ? JSON.parse(d) : def; } catch { return def; } };
const getTodayString = () => { const t = new Date(); return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); };

const api = async (path) => { const r = await fetch(`${API_BASE}${path}`); return r.json(); };
const apiSend = async (path, method, body) => { const r = await fetch(`${API_BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };

const normalizeName = (n) => (n || '').toString().trim().toUpperCase().replace(/\s+/g, ' ')
  .replace(/Ą/g,'A').replace(/Ć/g,'C').replace(/Ę/g,'E').replace(/Ł/g,'L').replace(/Ń/g,'N').replace(/Ó/g,'O').replace(/Ś/g,'S').replace(/Ź/g,'Z').replace(/Ż/g,'Z');

// ── Giełda zamian (helpery) ──
const dfmtSw = (ds) => { const d = new Date(ds); const dni = ['nd','pn','wt','śr','cz','pt','sb']; return `${dni[d.getDay()]} ${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`; };
const opisZmiany = (s) => `${dfmtSw(s.date)} · ${s.station} · ${s.start}–${s.end} (${s.hours}h)`;
const swapKey = (s) => s.date + '|' + s.station + '|' + s.start + '|' + s.end;
const statusZamiany = (s) => {
  if (s.status === 'approved') return { txt: `Zatwierdzona — przejęła: ${s.approvedVolunteer}`, kol: '#2E9E5B', bg: '#e9f7ef' };
  if (s.status === 'rejected') return { txt: 'Odrzucona przez ASM', kol: '#E74C3C', bg: '#fdecea' };
  if (s.status === 'cancelled') return { txt: 'Anulowana', kol: '#94a3b8', bg: '#f1f5f9' };
  return s.volunteers.length ? { txt: `Zgłoszeń: ${s.volunteers.length} — czeka na akceptację ASM`, kol: '#F5B000', bg: '#fff8e6' } : { txt: 'Otwarta — czeka na chętnych', kol: colors.primary.medium, bg: colors.primary.bgLight };
};

const calcHours = (start, end) => {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return h;
};

// ===================== LOGIN =====================

const LoginScreen = ({ onLogin }) => {
  const [login, setLogin] = useState('');
  const [haslo, setHaslo] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('login'); // 'login' | 'newpass'
  const [acc, setAcc] = useState(null);
  const [zapamietaj, setZapamietaj] = useState(true);
  const [zapisane, setZapisane] = useState(null);   // { login, haslo, imie }

  useEffect(() => {
    const z = loadFromStorage('rex_creds', null);
    if (z && z.login) { setZapisane(z); setLogin(z.login); setHaslo(z.haslo || ''); }
  }, []);

  const zapomnij = () => { try { localStorage.removeItem('rex_creds'); } catch {} setZapisane(null); setLogin(''); setHaslo(''); };
  const [startowe, setStartowe] = useState('');
  const [np1, setNp1] = useState('');
  const [np2, setNp2] = useState('');

  const toUser = (a) => ({ id: a.id, name: a.grafikName || a.name, display: a.name, login: a.login });

  const submit = async () => {
    if (!login.trim() || !haslo) { setError('Podaj login i hasło'); return; }
    setLoading(true); setError('');
    try {
      const r = await apiSend('/accounts?action=auth', 'POST', { login: login.trim(), haslo });
      if (r.success) {
        if (r.account.mustChange) { setAcc(r.account); setStartowe(haslo); setStep('newpass'); }
        else {
          const u = toUser(r.account);
          try { if (window.PasswordCredential && navigator.credentials) { navigator.credentials.store(new window.PasswordCredential({ id: login.trim(), password: haslo, name: u.display })); } } catch {}
          if (zapamietaj) saveToStorage('rex_creds', { login: login.trim(), haslo, imie: u.display }); else { try { localStorage.removeItem('rex_creds'); } catch {} }
          saveToStorage('rex_user', u); onLogin(u);
        }
      } else setError(r.error || 'Nieprawidłowy login lub hasło');
    } catch { setError('Błąd połączenia z serwerem'); }
    setLoading(false);
  };
  const savePass = async () => {
    if (!/^\d{4,8}$/.test(np1)) { setError('PIN musi mieć 4–8 cyfr'); return; }
    if (np1 !== np2) { setError('PIN-y nie są takie same'); return; }
    setLoading(true); setError('');
    try {
      const r = await apiSend('/accounts?action=setpass', 'POST', { login: acc.login, oldHaslo: startowe, newPass: np1 });
      if (r.success) {
        const u = toUser(acc);
        if (zapamietaj) saveToStorage('rex_creds', { login: acc.login, haslo: np1, imie: u.display });
        saveToStorage('rex_user', u); onLogin(u);
      }
      else setError(r.error || 'Nie udało się ustawić hasła');
    } catch { setError('Błąd połączenia z serwerem'); }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{background: 'linear-gradient(to bottom, #0d3431, '+colors.primary.darkest+')'}}>
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-3 mb-12">
          <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{backgroundColor: colors.primary.medium}}><Cloud size={32} className="text-white" /></div>
          <div><span className="text-white text-3xl font-light">REX</span><span className="text-3xl font-light ml-2" style={{color: colors.primary.bg}}>Cloud</span><span className="block text-[11px] font-bold tracking-[0.35em] mt-1" style={{color: colors.primary.light}}>EMPLOYEE</span></div>
        </div>
        <div className="bg-white rounded-2xl p-8">
          {step === 'login' ? (<>
            <div className="flex items-center justify-center gap-2 mb-2"><Lock size={20} style={{color: colors.primary.medium}} /><h2 className="text-2xl font-semibold">Zaloguj się</h2></div>
            <p className="text-center text-sm text-slate-500 mb-6">{zapisane ? `Zalogujesz się jako ${zapisane.imie || zapisane.login}` : 'Podaj login i PIN otrzymany od menedżera'}</p>
            {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>}
            <div className="space-y-3">
              <div><label className="block text-sm text-slate-600 mb-1">Login</label><input name="username" id="username" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} className="w-full px-4 py-3 rounded-xl border font-mono focus:outline-none" disabled={loading} autoFocus={!zapisane} /></div>
              <div><label className="block text-sm text-slate-600 mb-1">PIN</label><input type="password" name="password" id="current-password" autoComplete="current-password" inputMode="numeric" maxLength={8} value={haslo} onChange={(e) => setHaslo(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} className="w-full px-4 py-3 rounded-xl border tracking-[0.4em] text-center focus:outline-none" placeholder="••••••" disabled={loading} /></div>
              <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={zapamietaj} onChange={(e) => setZapamietaj(e.target.checked)} />Zapamiętaj mnie na tym urządzeniu</label>
              <button onClick={submit} disabled={loading} className="w-full text-white font-semibold py-3 rounded-xl" style={{backgroundColor: loading ? colors.primary.light : colors.primary.medium}}>{loading ? 'Sprawdzam...' : 'Zaloguj'}</button>
              {zapisane && <button onClick={zapomnij} disabled={loading} className="w-full text-sm py-2 rounded-xl" style={{color: colors.primary.medium}}>To nie ja — wyczyść zapisane dane</button>}
            </div>
            <p className="text-xs text-slate-400 text-center mt-4">Konto zakłada kierownik / ASM</p>
          </>) : (<>
            <div className="flex items-center justify-center gap-2 mb-2"><Lock size={20} style={{color: colors.primary.medium}} /><h2 className="text-2xl font-semibold">Ustaw nowy PIN</h2></div>
            <p className="text-center text-sm text-slate-500 mb-6">Pierwsze logowanie — zmień PIN startowy na własny (4–8 cyfr).</p>
            {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">{error}</div>}
            <div className="space-y-3">
              <div><label className="block text-sm text-slate-600 mb-1">Nowy PIN (4–8 cyfr)</label><input type="password" autoComplete="new-password" inputMode="numeric" maxLength={8} value={np1} onChange={(e) => setNp1(e.target.value.replace(/\D/g, ''))} className="w-full px-4 py-3 rounded-xl border tracking-[0.5em] text-center" placeholder="••••" disabled={loading} autoFocus /></div>
              <div><label className="block text-sm text-slate-600 mb-1">Powtórz PIN</label><input type="password" autoComplete="new-password" inputMode="numeric" maxLength={8} value={np2} onChange={(e) => setNp2(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && savePass()} className="w-full px-4 py-3 rounded-xl border tracking-[0.5em] text-center" placeholder="••••" disabled={loading} /></div>
              <button onClick={savePass} disabled={loading} className="w-full text-white font-semibold py-3 rounded-xl" style={{backgroundColor: loading ? colors.primary.light : colors.primary.medium}}>{loading ? 'Zapisuję...' : 'Zapisz i wejdź'}</button>
            </div>
          </>)}
        </div>
      </div>
    </div>
  );
};

// ===================== CALENDAR =====================

const CalendarView = ({ date, onDateChange, shifts, onDayClick, selectedDay }) => {
  const year = date.getFullYear(), month = date.getMonth();
  const firstDay = new Date(year, month, 1), lastDay = new Date(year, month + 1, 0), startDay = (firstDay.getDay() + 6) % 7;
  const days = [];
  for (let i = 0; i < startDay; i++) days.push({ day: new Date(year, month, 0).getDate() - startDay + i + 1, current: false });
  for (let i = 1; i <= lastDay.getDate(); i++) days.push({ day: i, current: true });
  for (let i = 1; days.length < 42; i++) days.push({ day: i, current: false });
  const getShifts = (d) => { const ds = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); return shifts.filter(s => s.date === ds); };
  const today = new Date(), isToday = (d) => today.getDate() === d && today.getMonth() === month && today.getFullYear() === year;
  const hlStyle = (item) => { if (!item.current) return {}; if (selectedDay !== null) { if (item.day === selectedDay) return {backgroundColor: colors.primary.bg, color: colors.primary.dark}; return {}; } if (isToday(item.day)) return {backgroundColor: colors.primary.medium, color: 'white'}; return {}; };
  return (
    <div className="bg-white">
      <div className="flex items-center justify-between px-4 py-4 border-b"><button onClick={() => onDateChange(new Date(year, month-1, 1))} className="p-2"><ChevronLeft size={24} /></button><span className="text-lg font-semibold">{monthNames[month]} {year}</span><button onClick={() => onDateChange(new Date(year, month+1, 1))} className="p-2"><ChevronRight size={24} /></button></div>
      <div className="grid grid-cols-7 gap-1 p-2">
        {dayNames.map(d => <div key={d} className="text-center text-xs font-medium py-2 rounded-lg" style={{backgroundColor: colors.primary.bg, color: colors.primary.light}}>{d}</div>)}
        {days.map((item, i) => { const sh = item.current ? getShifts(item.day) : []; return (
          <button key={i} onClick={() => item.current && onDayClick(item.day === selectedDay ? null : item.day)} className={'flex flex-col items-center py-2 rounded-full ' + (!item.current ? 'text-slate-300' : '')} style={hlStyle(item)}>
            <span className="text-sm font-medium">{item.day}</span>
            {sh.length > 0 && item.current && <div className="flex gap-0.5 mt-1">{sh.slice(0,3).map((s,j) => <div key={j} className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: stationColor(s.station)}} />)}</div>}
          </button>
        ); })}
      </div>
    </div>
  );
};

// ===================== SIDEBAR / HEADER =====================

const Sidebar = ({ isOpen, onClose, currentPage, onNavigate, user, onLogout }) => {
  const items = [{ id: 'home', icon: Home, label: 'Strona domowa' }, { id: 'shifts', icon: Calendar, label: 'Mój grafik' }, { id: 'hours', icon: Clock, label: 'Moje godziny' }, { id: 'swaps', icon: RefreshCw, label: 'Giełda zamian' }, { id: 'about', icon: Info, label: 'O aplikacji' }];
  const initials = (user.display || user.name).split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
  return (<>{isOpen && <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />}
    <div className={'fixed top-0 left-0 h-full w-72 bg-white z-50 transform transition-transform flex flex-col ' + (isOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="p-4 pt-8" style={{background: 'linear-gradient(to right, '+colors.primary.darkest+', '+colors.primary.dark+')'}}><div className="flex items-center gap-2 mb-4"><Cloud size={24} className="text-white" /><span className="text-white text-lg font-light">REX <span style={{color: colors.primary.bg}}>Cloud</span> <span className="text-[10px] font-bold tracking-widest align-middle" style={{color: colors.primary.light}}>EMPLOYEE</span></span></div></div>
      <div className="p-4 border-b flex items-center gap-3"><div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold" style={{backgroundColor: colors.primary.medium}}>{initials}</div><div><p className="font-semibold text-sm">{user.display || user.name}</p><p className="text-slate-500 text-xs">Pracownik</p></div></div>
      <nav className="p-4 flex-1">{items.map(item => (<button key={item.id} onClick={() => { onNavigate(item.id); onClose(); }} className="w-full flex items-center gap-4 px-4 py-3 rounded-xl" style={currentPage === item.id ? {backgroundColor: colors.primary.bg, color: colors.primary.dark} : {color: '#475569'}}><item.icon size={20} /><span className="font-medium">{item.label}</span></button>))}</nav>
      <div className="p-4 border-t"><button onClick={() => { onLogout(); onClose(); }} className="w-full flex items-center gap-4 px-4 py-3 rounded-xl text-red-600"><LogOut size={20} /><span className="font-medium">Wyloguj się</span></button></div>
    </div></>);
};

const Header = ({ title, onMenuClick }) => (<div className="text-white px-4 py-4 flex items-center justify-between sticky top-0 z-30" style={{background: 'linear-gradient(to right, '+colors.primary.dark+', '+colors.primary.darkest+')'}}><div className="flex items-center gap-3"><Cloud size={24} /><span className="text-lg font-medium">{title}</span></div><button onClick={onMenuClick} className="p-2"><Menu size={24} /></button></div>);

// ===================== SHIFT CARD =====================

// Wykrywanie podwójnego kliknięcia/tapnięcia (niezawodne na telefonie i desktopie)
const DblTapRow = ({ children, onDouble }) => {
  const last = React.useRef(0);
  const handle = () => { const now = Date.now(); if (now - last.current < 350) { last.current = 0; onDouble(); } else { last.current = now; } };
  return <div onClick={handle} className="mb-3 cursor-pointer select-none">{children}</div>;
};

// Okienko „Współpracownicy ze zmiany"
const CoworkersModal = ({ date, list, loading, onClose }) => {
  const d = new Date(date);
  const dateLabel = `${dniPelne[d.getDay()]}, ${d.getDate()} ${monthNamesGen[d.getMonth()]} ${d.getFullYear()}`;
  const inicjaly = (n) => n.split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-t-3xl max-h-[80vh] flex flex-col">
        <div className="p-5 border-b"><h2 className="text-xl font-bold" style={{ color: colors.primary.darkest }}>Współpracownicy ze zmiany</h2><p className="text-sm text-slate-500 mt-1 capitalize">{dateLabel}</p></div>
        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {loading ? (<div className="flex items-center justify-center py-10"><Cloud size={36} style={{ color: colors.primary.medium }} className="animate-pulse" /></div>)
            : list.length === 0 ? (<p className="text-slate-400 text-center py-8">Nikt więcej nie pracuje tego dnia.</p>)
            : list.map((s, i) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-xl">
                <div className="w-11 h-11 rounded-full flex items-center justify-center text-white font-semibold shrink-0" style={{ backgroundColor: stationColor(s.station) }}>{inicjaly(s.name)}</div>
                <div className="flex-1 min-w-0"><p className="font-semibold truncate" style={{ color: colors.primary.darkest }}>{s.name}</p><p className="text-sm text-slate-500">{s.start} - {s.end}</p></div>
                <span className="text-xs px-2 py-1 rounded font-medium shrink-0" style={{ backgroundColor: colors.primary.bg, color: stationColor(s.station) }}>{nazwaStanowiska(s)}</span>
              </div>
            ))}
        </div>
        <div className="p-4 border-t"><button onClick={onClose} className="w-full text-white font-semibold py-3 rounded-xl" style={{ backgroundColor: colors.primary.medium }}>Ok</button></div>
      </div>
    </div>
  );
};

const ShiftCard = ({ shift, isToday, onTeam }) => {
  const d = new Date(shift.date);
  const h = shift.hours != null ? shift.hours : calcHours(shift.start, shift.end);
  return (
    <div className="relative rounded-xl shadow-sm p-4" style={{ backgroundColor: isToday ? colors.primary.bg : 'white', borderLeft: '4px solid ' + stationColor(shift.station) }}>
      {onTeam && (
        <button onClick={(e) => { e.stopPropagation(); onTeam(); }} className="absolute top-2 right-2 w-9 h-9 rounded-full flex items-center justify-center" style={{ backgroundColor: colors.primary.bg }} title="Współpracownicy ze zmiany">
          <Users size={18} style={{ color: colors.primary.medium }} />
        </button>
      )}
      <div className="flex gap-4">
        <div className="rounded-xl px-3 py-2 text-center min-w-16" style={{backgroundColor: isToday ? colors.primary.bgLight : colors.primary.bg}}>
          <p className="text-xs" style={{color: colors.primary.light}}>{dayShort[d.getDay()]}</p>
          <p className="text-xl font-bold">{d.getDate()}.{String(d.getMonth()+1).padStart(2,'0')}</p>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={16} className="text-slate-400" />
            <span className="font-semibold">{shift.start} - {shift.end}</span>
            <span className="text-xs px-2 py-0.5 rounded font-medium" style={{backgroundColor: colors.primary.bg, color: colors.primary.dark}}>{h}h</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Briefcase size={14} style={{color: stationColor(shift.station)}} />
            <span className="text-sm font-medium" style={{color: stationColor(shift.station)}}>{nazwaStanowiska(shift)}</span>
          </div>
          {paraLabel(shift) && (
            <div className="flex items-center gap-2 mt-1">
              <Search size={14} style={{color: stationColor(shift.station)}} />
              <span className="text-sm" style={{color: colors.primary.dark}}>{paraLabel(shift).rola}: <span className="font-semibold">{paraLabel(shift).osoba}</span></span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1"><MapPin size={14} className="text-slate-400" /><span className="text-slate-500 text-sm">{DEFAULT_LOCATION}</span></div>
        </div>
      </div>
    </div>
  );
};

// ===================== PAGES =====================

const HomePage = ({ nextShift, onNavigateToShifts, monthHours, monthShiftCount }) => {
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force(n => n + 1), 60000); return () => clearInterval(i); }, []);
  const countdown = () => {
    if (!nextShift) return { days: 0, hours: 0, min: 0 };
    const target = new Date(nextShift.date); const [h, m] = nextShift.start.split(':'); target.setHours(+h, +m, 0, 0);
    const diff = target - new Date();
    if (diff <= 0) return { days: 0, hours: 0, min: 0 };
    return { days: Math.floor(diff / 86400000), hours: Math.floor((diff % 86400000) / 3600000), min: Math.floor((diff % 3600000) / 60000) };
  };
  const cd = countdown();
  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="bg-white rounded-2xl shadow-sm p-4 cursor-pointer" style={{borderLeft: '4px solid '+colors.primary.medium}} onClick={onNavigateToShifts}>
        <div className="flex items-center justify-between mb-4"><h3 className="text-lg font-semibold">Następna zmiana</h3><Calendar size={24} style={{color: colors.primary.medium}} /></div>
        {nextShift ? (
          <div className="flex gap-4">
            <div className="rounded-xl p-3 text-center min-w-16" style={{backgroundColor: colors.primary.bg}}><p className="text-sm" style={{color: colors.primary.light}}>{dayShort[new Date(nextShift.date).getDay()]}</p><p className="text-3xl font-bold">{new Date(nextShift.date).getDate()}</p><p className="text-xs" style={{color: colors.primary.light}}>{monthNames[new Date(nextShift.date).getMonth()].slice(0,3).toUpperCase()}</p></div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1"><Clock size={16} className="text-slate-400" /><span className="font-semibold">{nextShift.start} - {nextShift.end}</span></div>
              <div className="flex items-center gap-2 mb-2"><Briefcase size={14} style={{color: stationColor(nextShift.station)}} /><span className="text-sm font-medium" style={{color: stationColor(nextShift.station)}}>{nextShift.station}</span></div>
              <div className="flex gap-4 mt-3 pt-3 border-t">
                <div className="text-center"><p className="text-2xl font-bold" style={{color: colors.primary.medium}}>{cd.days}</p><p className="text-xs text-slate-500">Dni</p></div>
                <div className="text-center"><p className="text-2xl font-bold">{cd.hours}</p><p className="text-xs text-slate-500">godz</p></div>
                <div className="text-center"><p className="text-2xl font-bold">{cd.min}</p><p className="text-xs text-slate-500">min</p></div>
              </div>
              <p className="text-xs text-slate-400 mt-2">do rozpoczęcia</p>
            </div>
          </div>
        ) : (<div className="text-center py-4"><Cloud size={40} className="text-slate-200 mx-auto mb-2" /><p className="text-slate-500">Brak zaplanowanych zmian</p></div>)}
      </div>
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h3 className="text-lg font-semibold mb-4">Ten miesiąc</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl p-4 text-center" style={{backgroundColor: colors.primary.bg}}><p className="text-3xl font-bold" style={{color: colors.primary.dark}}>{monthHours.toFixed(1)}</p><p className="text-sm" style={{color: colors.primary.light}}>godzin</p></div>
          <div className="rounded-xl p-4 text-center" style={{backgroundColor: colors.accent.bg}}><p className="text-3xl font-bold" style={{color: colors.accent.dark}}>{monthShiftCount}</p><p className="text-sm" style={{color: colors.accent.dark}}>zmian</p></div>
        </div>
      </div>
    </div>
  );
};

const ShiftsPage = ({ date, onDateChange, shifts, onOpenTeam }) => {
  const [selectedDay, setSelectedDay] = useState(null);
  const todayStr = getTodayString();
  const filtered = shifts.filter(s => { const d = new Date(s.date); return (!selectedDay || d.getDate() === selectedDay) && d.getMonth() === date.getMonth() && d.getFullYear() === date.getFullYear(); }).sort((a, b) => new Date(a.date) - new Date(b.date) || a.start.localeCompare(b.start));
  return (
    <div className="flex flex-col min-h-screen bg-slate-50 pb-20">
      <CalendarView date={date} onDateChange={onDateChange} shifts={shifts} onDayClick={setSelectedDay} selectedDay={selectedDay} />
      <div className="flex-1 p-4">
        {filtered.length === 0 ? (<div className="text-center py-12"><Cloud size={48} className="text-slate-300 mx-auto mb-4" /><p className="text-slate-500">Brak zmian w tym okresie</p></div>) : (<>
          <p className="text-xs text-slate-400 mb-3 flex items-center gap-1"><Users size={13} />Kliknij dwukrotnie dzień (lub ikonę) — zobaczysz zespół</p>
          {filtered.map((shift, i) => (
            <div key={i}>
              {shift.date === todayStr && (<div className="flex items-center gap-2 mb-2 px-2"><div className="h-px flex-1" style={{backgroundColor: colors.primary.medium}}></div><span className="text-xs font-semibold px-2 py-1 rounded-full" style={{backgroundColor: colors.primary.bg, color: colors.primary.dark}}>DZIŚ</span><div className="h-px flex-1" style={{backgroundColor: colors.primary.medium}}></div></div>)}
              <DblTapRow onDouble={() => onOpenTeam(shift.date)}><ShiftCard shift={shift} isToday={shift.date === todayStr} onTeam={() => onOpenTeam(shift.date)} /></DblTapRow>
            </div>
          ))}
        </>)}
      </div>
    </div>
  );
};

const HoursPage = ({ shifts }) => {
  const now = new Date();
  const monthsData = useMemo(() => {
    const arr = [];
    for (let i = 2; i >= 0; i--) {
      let month = now.getMonth() - i, year = now.getFullYear();
      if (month < 0) { month += 12; year -= 1; }
      const ms = shifts.filter(s => { const d = new Date(s.date); return d.getMonth() === month && d.getFullYear() === year; });
      const totalH = ms.reduce((a, s) => a + (s.hours != null ? s.hours : calcHours(s.start, s.end)), 0);
      // Station breakdown
      const stations = {};
      ms.forEach(s => { const st = s.station || 'Inne'; stations[st] = (stations[st] || 0) + (s.hours != null ? s.hours : calcHours(s.start, s.end)); });
      arr.push({ month, year, label: monthNames[month].slice(0, 3), fullLabel: monthNames[month], totalHours: totalH, count: ms.length, stations });
    }
    return arr;
  }, [shifts]);
  const cur = monthsData[2];
  const max = Math.max(...monthsData.map(m => m.totalHours), 1);
  return (
    <div className="min-h-screen bg-slate-50 p-4 pb-24 space-y-4">
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <div className="flex items-center justify-between mb-4"><h3 className="text-lg font-semibold">{cur.fullLabel} {cur.year}</h3><Clock size={24} style={{color: colors.primary.medium}} /></div>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl p-4 text-center" style={{backgroundColor: colors.primary.bg}}><p className="text-3xl font-bold" style={{color: colors.primary.dark}}>{cur.totalHours.toFixed(1)}</p><p className="text-sm" style={{color: colors.primary.light}}>godzin</p></div>
          <div className="rounded-xl p-4 text-center" style={{backgroundColor: colors.accent.bg}}><p className="text-3xl font-bold" style={{color: colors.accent.dark}}>{cur.count}</p><p className="text-sm" style={{color: colors.accent.dark}}>zmian</p></div>
        </div>
      </div>
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h3 className="text-lg font-semibold mb-4">Ostatnie 3 miesiące</h3>
        <div className="flex items-end justify-between gap-2 h-32">{monthsData.map((m, i) => { const h = (m.totalHours / max) * 100; return (<div key={i} className="flex flex-col items-center flex-1"><span className="text-xs font-semibold mb-1">{m.totalHours.toFixed(0)}h</span><div className="w-full rounded-t-lg" style={{ height: Math.max(h, 5)+'%', backgroundColor: colors.primary.medium, opacity: i === 2 ? 1 : 0.6 }} /><span className="text-xs text-slate-500 mt-2">{m.label}</span></div>); })}</div>
      </div>
      {Object.keys(cur.stations).length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <h3 className="text-lg font-semibold mb-4">Podział wg stanowisk — {cur.fullLabel}</h3>
          <div className="space-y-2">
            {Object.entries(cur.stations).sort((a,b) => b[1]-a[1]).map(([st, h]) => { const pct = (h / cur.totalHours) * 100; return (
              <div key={st} className="flex items-center gap-3">
                <span className="text-xs font-medium w-32 truncate">{st}</span>
                <div className="flex-1 h-4 bg-slate-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: pct+'%', backgroundColor: stationColor(st) }} /></div>
                <span className="text-sm text-slate-600 w-14 text-right">{h.toFixed(1)}h</span>
              </div>
            ); })}
          </div>
        </div>
      )}
    </div>
  );
};

const AboutPage = () => (
  <div className="min-h-screen bg-slate-50 p-4 pb-24"><div className="bg-white rounded-2xl overflow-hidden">
    <div className="p-8 text-center" style={{background: 'linear-gradient(to right, '+colors.primary.darkest+', '+colors.primary.dark+')'}}><Cloud size={40} className="text-white mx-auto mb-4" /><span className="text-white text-2xl font-light">REX <span style={{color: colors.primary.bg}}>Cloud</span></span><p className="mt-1 text-[11px] font-bold tracking-[0.3em]" style={{color: colors.primary.light}}>EMPLOYEE</p><p className="mt-1" style={{color: colors.primary.bg}}>WorkRhythm</p></div>
    <div className="p-6 space-y-4">
      <div className="rounded-xl p-4" style={{backgroundColor: colors.primary.bg}}><span className="font-semibold" style={{color: colors.primary.darkest}}>Jak to działa</span><ul className="text-sm mt-2 space-y-1" style={{color: colors.primary.dark}}><li>• Logujesz się swoim imieniem lub nazwiskiem</li><li>• Widzisz swój grafik ułożony przez kierownika</li><li>• Grafik pochodzi z matrycy Excel</li></ul></div>
      <p className="text-slate-500 text-sm text-center">© 2026 REX Cloud EMPLOYEE by M. Szewczyk</p>
    </div>
  </div></div>
);

// ===================== MAIN =====================

const SwapsPage = ({ user, shifts, swaps, onCreate, onVolunteer, onUnvolunteer, onCancel, onRefresh }) => {
  const me = user.name;
  const [sel, setSel] = useState('');
  const [note, setNote] = useState('');
  const today = getTodayString();
  const myUpcoming = shifts.filter(s => s.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const juz = new Set(swaps.filter(s => s.status === 'open' && normalizeName(s.requester) === normalizeName(me)).map(swapKey));
  const dostepneMoje = myUpcoming.filter(s => !juz.has(swapKey(s)));
  const otwarteInnych = swaps.filter(s => s.status === 'open' && normalizeName(s.requester) !== normalizeName(me));
  const mojeProsby = swaps.filter(s => normalizeName(s.requester) === normalizeName(me)).sort((a, b) => b.createdAt - a.createdAt);
  const czyZgloszony = (s) => s.volunteers.some(v => normalizeName(v) === normalizeName(me));
  const wyslij = () => { const s = dostepneMoje.find(x => swapKey(x) === sel); if (!s) return; onCreate(s, note); setSel(''); setNote(''); };
  const inp = 'w-full px-3 py-2.5 rounded-xl border';

  return (
    <div className="p-4 space-y-4 pb-24">
      <div className="flex justify-end"><button onClick={onRefresh} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg" style={{ color: colors.primary.medium }}><RefreshCw size={16} />Odśwież</button></div>

      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h3 className="font-semibold mb-1" style={{ color: colors.primary.darkest }}>Oddaj zmianę do zamiany</h3>
        <p className="text-xs mb-3" style={{ color: colors.primary.light }}>Wybierz swoją nadchodzącą zmianę — trafi na giełdę, a ASM zatwierdzi finalną zamianę.</p>
        {dostepneMoje.length === 0 ? <p className="text-sm text-slate-400">Brak nadchodzących zmian do wystawienia.</p> : (
          <div className="space-y-2">
            <select value={sel} onChange={e => setSel(e.target.value)} className={inp} style={{ borderColor: colors.primary.bg }}>
              <option value="">— wybierz zmianę —</option>
              {dostepneMoje.map(s => <option key={swapKey(s)} value={swapKey(s)}>{opisZmiany(s)}</option>)}
            </select>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Powód (opcjonalnie)" className={inp} style={{ borderColor: colors.primary.bg }} />
            <button onClick={wyslij} className="w-full text-white font-semibold py-2.5 rounded-xl" style={{ backgroundColor: colors.primary.medium }}>Wyślij prośbę o zamianę</button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h3 className="font-semibold mb-3" style={{ color: colors.primary.darkest }}>Giełda — zmiany innych ({otwarteInnych.length})</h3>
        {otwarteInnych.length === 0 ? <p className="text-sm text-slate-400">Brak otwartych zamian.</p> : (
          <div className="space-y-2">
            {otwarteInnych.map(s => (
              <div key={s.id} className="rounded-xl p-3 flex items-center justify-between gap-2" style={{ backgroundColor: colors.primary.bgLight }}>
                <div><p className="text-sm font-medium" style={{ color: colors.primary.darkest }}>{s.requester}</p><p className="text-xs" style={{ color: colors.primary.dark }}>{opisZmiany(s.shift)}</p>{s.note && <p className="text-xs italic text-slate-400">„{s.note}"</p>}</div>
                {czyZgloszony(s)
                  ? <button onClick={() => onUnvolunteer(s.id)} className="text-xs px-3 py-2 rounded-lg font-medium shrink-0" style={{ backgroundColor: '#fff8e6', color: '#F5B000' }}>Zgłoszony ✓</button>
                  : <button onClick={() => onVolunteer(s.id)} className="text-xs px-3 py-2 rounded-lg font-medium text-white shrink-0" style={{ backgroundColor: colors.primary.medium }}>Zgłoś się</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h3 className="font-semibold mb-3" style={{ color: colors.primary.darkest }}>Moje prośby ({mojeProsby.length})</h3>
        {mojeProsby.length === 0 ? <p className="text-sm text-slate-400">Nie masz jeszcze próśb o zamianę.</p> : (
          <div className="space-y-2">
            {mojeProsby.map(s => { const st = statusZamiany(s); return (
              <div key={s.id} className="rounded-xl p-3" style={{ backgroundColor: st.bg }}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium" style={{ color: colors.primary.dark }}>{opisZmiany(s.shift)}</p>
                  {s.status === 'open' && <button onClick={() => onCancel(s.id)} className="text-xs px-2 py-1 rounded-lg shrink-0" style={{ backgroundColor: 'white', color: '#E74C3C' }}>Anuluj</button>}
                </div>
                <p className="text-xs mt-1 font-medium" style={{ color: st.kol }}>{st.txt}</p>
                {s.status === 'open' && s.volunteers.length > 0 && <p className="text-xs mt-0.5 text-slate-500">Zgłoszeni: {s.volunteers.join(', ')}</p>}
              </div>
            ); })}
          </div>
        )}
      </div>
    </div>
  );
};

function REXCloudApp() {
  const [currentUser, setCurrentUser] = useState(() => loadFromStorage('rex_user', null));
  const [swaps, setSwaps] = useState([]);
  const [sidebar, setSidebar] = useState(false);
  const [page, setPage] = useState('home');
  const [date, setDate] = useState(() => new Date());
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [teamDate, setTeamDate] = useState(null);
  const [coworkers, setCoworkers] = useState([]);
  const [coLoading, setCoLoading] = useState(false);

  const openTeam = async (dateStr) => {
    setTeamDate(dateStr); setCoworkers([]); setCoLoading(true);
    try {
      const r = await api('/schedule?month=' + dateStr.slice(0, 7));
      const all = (r.success && r.shifts) ? r.shifts : [];
      const list = all.filter(s => s.date === dateStr && (currentUser.id && s.accountId ? s.accountId !== currentUser.id : normalizeName(s.name) !== normalizeName(currentUser.name))).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      setCoworkers(list);
    } catch { setCoworkers([]); }
    setCoLoading(false);
  };

  const zapytanieOsoby = (u) => u && u.id ? `/schedule?accountId=${encodeURIComponent(u.id)}` : `/schedule?name=${encodeURIComponent(u.name)}`;
  const reloadShifts = () => currentUser && api(zapytanieOsoby(currentUser)).then(r => { if (r.success) setShifts(scalZmiany(r.shifts)); }).catch(() => {});
  const reloadSwaps = () => api('/swaps').then(r => { if (r.success) setSwaps(r.swaps || []); }).catch(() => {});

  useEffect(() => {
    if (currentUser) {
      setLoading(true);
      Promise.all([
        api(zapytanieOsoby(currentUser)).then(r => { if (r.success) setShifts(scalZmiany(r.shifts)); }),
        api('/swaps').then(r => { if (r.success) setSwaps(r.swaps || []); }),
      ]).catch(() => {}).finally(() => setLoading(false));
    }
  }, [currentUser]);

  // odśwież po wejściu w zakładkę Zamiany (żeby widać było zatwierdzenia ASM)
  useEffect(() => { if (currentUser && page === 'swaps') { reloadShifts(); reloadSwaps(); } }, [page]);

  const createSwap = async (shift, note) => { const r = await apiSend('/swaps', 'POST', { requester: currentUser.name, shift, note }); if (r.success) reloadSwaps(); else alert(r.error || 'Nie udało się wysłać prośby'); };
  const volunteerSwap = async (id) => { const r = await apiSend('/swaps', 'PUT', { id, action: 'volunteer', name: currentUser.name }); if (r.success) reloadSwaps(); else alert(r.error || 'Błąd'); };
  const unvolunteerSwap = async (id) => { const r = await apiSend('/swaps', 'PUT', { id, action: 'unvolunteer', name: currentUser.name }); if (r.success) reloadSwaps(); };
  const cancelSwap = async (id) => { const r = await apiSend('/swaps', 'PUT', { id, action: 'cancel' }); if (r.success) reloadSwaps(); };

  const handleLogin = (u) => setCurrentUser(u);
  const handleLogout = () => { localStorage.removeItem('rex_user'); setCurrentUser(null); setPage('home'); setShifts([]); setSwaps([]); };

  const todayStr = getTodayString();
  const nextShift = shifts.filter(s => s.date >= todayStr).sort((a, b) => new Date(a.date) - new Date(b.date) || a.start.localeCompare(b.start))[0] || null;
  const now = new Date();
  const monthShifts = shifts.filter(s => { const d = new Date(s.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const monthHours = monthShifts.reduce((a, s) => a + (s.hours != null ? s.hours : calcHours(s.start, s.end)), 0);

  const titles = { home: 'Strona domowa', shifts: 'Mój grafik', hours: 'Moje godziny', swaps: 'Giełda zamian', about: 'O aplikacji' };

  if (!currentUser) return <LoginScreen onLogin={handleLogin} />;

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar isOpen={sidebar} onClose={() => setSidebar(false)} currentPage={page} onNavigate={setPage} user={currentUser} onLogout={handleLogout} />
      <Header title={titles[page] || 'REX Cloud EMPLOYEE'} onMenuClick={() => setSidebar(true)} />
      {loading ? (<div className="flex items-center justify-center py-20"><Cloud size={48} style={{color: colors.primary.medium}} className="animate-pulse" /></div>) : (<>
        {page === 'home' && <HomePage nextShift={nextShift} onNavigateToShifts={() => setPage('shifts')} monthHours={monthHours} monthShiftCount={monthShifts.length} />}
        {page === 'shifts' && <ShiftsPage date={date} onDateChange={setDate} shifts={shifts} onOpenTeam={openTeam} />}
        {page === 'hours' && <HoursPage shifts={shifts} />}
        {page === 'swaps' && <SwapsPage user={currentUser} shifts={shifts} swaps={swaps} onCreate={createSwap} onVolunteer={volunteerSwap} onUnvolunteer={unvolunteerSwap} onCancel={cancelSwap} onRefresh={() => { reloadShifts(); reloadSwaps(); }} />}
        {page === 'about' && <AboutPage />}
      </>)}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t px-4 py-2 flex justify-around z-10">
        {[['home', Home, 'Home'], ['shifts', Calendar, 'Grafik'], ['hours', Clock, 'Godziny'], ['swaps', RefreshCw, 'Zamiany'], ['about', Info, 'Info']].map(([id, Icon, label]) => (
          <button key={id} onClick={() => setPage(id)} className="flex flex-col items-center p-2" style={{color: page === id ? colors.primary.medium : '#94a3b8'}}><Icon size={24} /><span className="text-xs mt-1">{label}</span></button>
        ))}
      </div>
      {teamDate && <CoworkersModal date={teamDate} list={coworkers} loading={coLoading} onClose={() => setTeamDate(null)} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<REXCloudApp />);
