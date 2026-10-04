import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './lib/store';
import { useI18n } from './i18n';
import { Icon, ICONS, Loading, Logo } from './components/ui';
import { Login, Register, Forgot, ResetPassword, VerifyEmail } from './pages/Auth';
import Home from './pages/Home';

const Create = lazy(() => import('./pages/Create'));
const Assistant = lazy(() => import('./pages/Assistant'));
const ImageStudio = lazy(() => import('./pages/ImageStudio'));
const VideoStudio = lazy(() => import('./pages/VideoStudio'));
const PromoStudio = lazy(() => import('./pages/PromoStudio'));
const PhotoEditor = lazy(() => import('./pages/PhotoEditor'));
const VideoEditor = lazy(() => import('./pages/VideoEditor'));
const Reels = lazy(() => import('./pages/Reels'));
const Chat = lazy(() => import('./pages/Chat'));
const Profile = lazy(() => import('./pages/Profile'));
const UserPage = lazy(() => import('./pages/UserPage'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Search = lazy(() => import('./pages/Search'));
const Compose = lazy(() => import('./pages/Compose'));
const PostPage = lazy(() => import('./pages/PostPage'));
const Admin = lazy(() => import('./pages/admin/Admin'));

function Splash() {
  const [gone, setGone] = useState(() => { try { return sessionStorage.getItem('madix_splash') === '1'; } catch { return false; } });
  const { configReady } = useApp();
  useEffect(() => { const id = setTimeout(() => { setGone(true); try { sessionStorage.setItem('madix_splash', '1'); } catch { /* ignore */ } }, 1700); return () => clearTimeout(id); }, []);
  if (gone) return null;
  return <div className="splash" aria-hidden>{configReady ? <Logo kind="splash" size={56} stacked /> : null}</div>;
}

function Shell() {
  const { t } = useI18n(); const { chatUnread, me, config } = useApp(); const loc = useLocation();
  const immersive = loc.pathname.startsWith('/reels');
  void immersive;
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="rail-brand"><Logo size={30} /></div>
        <NavLink to="/" end><Icon d={ICONS.home} /><span>{t('nav.home')}</span></NavLink>
        <NavLink to="/create" className="create-btn"><span className="plus"><Icon d={ICONS.create} size={20} /></span><span>{t('nav.create')}</span></NavLink>
        <NavLink to="/reels"><Icon d={ICONS.reels} /><span>{t('nav.reels')}</span></NavLink>
        <NavLink to="/chat"><Icon d={ICONS.chat} /><span>{t('nav.chat')}</span>{chatUnread > 0 && <i className="badge">{chatUnread > 9 ? '9+' : chatUnread}</i>}</NavLink>
        <NavLink to="/profile"><Icon d={ICONS.profile} /><span>{t('nav.profile')}</span></NavLink>
      </nav>
      <main className={`main ${/^\/(pricing|chat|create\/(video-editor|photo-editor|assistant))/.test(loc.pathname) ? 'wide' : ''}`} id="main">
        <Suspense fallback={<Loading />}><Outlet /></Suspense>
        {!me && !loc.pathname.startsWith('/reels') && <p className="muted" style={{ textAlign: 'center', marginTop: 32, fontSize: '.85rem' }}>{config.branding.positioning}</p>}
      </main>
    </div>
  );
}

function Protected() {
  const { me, authReady } = useApp();
  if (!authReady) return <div className="auth"><Loading rows={2} /></div>;
  if (!me) return <Navigate to="/login" replace />;
  return <Shell />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <a href="#main" className="sr-only">Skip to content</a>
        <Splash />
        <Routes>
          <Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/forgot-password" element={<Forgot />} />
          <Route path="/reset-password" element={<ResetPassword />} /><Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/admin/*" element={<Suspense fallback={<div className="auth"><Loading rows={2} /></div>}><Admin /></Suspense>} />
          <Route element={<Protected />}>
            <Route path="/" element={<Home />} />
            <Route path="/create" element={<Create />} />
            <Route path="/create/assistant" element={<Assistant />} />
            <Route path="/create/image" element={<ImageStudio />} />
            <Route path="/create/video" element={<VideoStudio />} />
            <Route path="/create/promo" element={<PromoStudio />} />
            <Route path="/create/photo-editor" element={<PhotoEditor />} />
            <Route path="/create/video-editor" element={<VideoEditor />} />
            <Route path="/compose" element={<Compose />} />
            <Route path="/reels" element={<Reels />} />
            <Route path="/chat" element={<Chat />} /><Route path="/chat/:id" element={<Chat />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/u/:username" element={<UserPage />} />
            <Route path="/post/:id" element={<PostPage />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/search" element={<Search />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}
