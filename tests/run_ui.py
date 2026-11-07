# Parcours complet de l'interface sur le monde simulé (python3 tests/run_ui.py)
import base64, os, re, sys, time, subprocess, json
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get('SHOTS', '/home/claude/shots')
os.makedirs(OUT, exist_ok=True)
PORT = 8765
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

# Tuile de fond neutre (les vrais fonds de carte ne sont pas joignables ici).
TILE = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP48f8/AAWEAsGHi7vDAAAAAElFTkSuQmCC')
errors = []

def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png')
    print('  capture', name)

def visible(page, sel):
    return page.locator(sel).is_visible()

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, locale='fr-FR', timezone_id='Europe/Rome')
        ctx.route(re.compile(r'basemaps\.cartocdn\.com'), lambda r: r.fulfill(status=200, content_type='image/png', body=TILE))
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        page.add_init_script("Object.defineProperty(window, 'speechSynthesis', { value: { speak(u){ if (u.text && u.text.trim()) (window.__spoken = window.__spoken || []).push(u.text); }, cancel(){}, getVoices(){ return []; } }, configurable: true }); window.SpeechSynthesisUtterance = function(t){ this.text = t; };")
        page.goto(f'http://127.0.0.1:{PORT}/index.html?mock=1&gap=30')
        page.wait_for_selector('#screen-home.active')
        page.wait_for_timeout(400)
        shot(page, '01-accueil-boucle')

        # Boucle 3 h, découverte 60 %
        page.click('#go')
        page.wait_for_selector('#screen-search.active')
        page.wait_for_timeout(700)
        shot(page, '02-recherche')
        page.wait_for_selector('#screen-list.active', timeout=60000)
        page.wait_for_timeout(300)
        shot(page, '03-liste')
        cards = page.locator('.route-card').count()
        names = page.locator('.route-name').all_inner_texts()
        print('  parcours :', cards, names)

        page.locator('.route-card').first.click()
        page.wait_for_selector('#screen-detail.active')
        page.wait_for_selector('#detail-updating', state='hidden', timeout=20000)
        page.wait_for_timeout(500)
        shot(page, '04-detail')
        print('  détail :', page.inner_text('#detail-stats'), '|', page.inner_text('#detail-sub'))
        print('  programme :', [t.replace('\n', ' ') for t in page.locator('#detail-timeline li').all_inner_texts()])

        # Navigation simulée
        page.click('#detail-sim')
        page.wait_for_selector('#screen-nav.active')
        page.wait_for_timeout(2500)
        shot(page, '05-navigation')
        print('  manœuvre :', page.inner_text('#man-dist'), page.inner_text('#man-text'), '|', page.inner_text('#man-street'))
        # Accélère la simulation
        page.click('#nav-options')
        page.click('#nav-sheet [data-k="10"]')
        page.click('#nav-sheet [data-act="close"]')
        page.wait_for_timeout(3000)
        # Sortie volontaire du parcours
        page.click('#nav-options')
        shot(page, '06-options')
        page.click('#nav-sheet [data-act="deviate"]')
        t0 = time.time()
        saw_off = False
        while time.time() - t0 < 20:
            if visible(page, '#offroute'):
                saw_off = True
                txt = page.inner_text('#offroute')
                if 'recalcul' in txt:
                    shot(page, '07-hors-parcours')
                    break
            page.wait_for_timeout(250)
        page.wait_for_function("() => window.__viree.nav && window.__viree.nav.engine.reroutes > 0", timeout=25000)
        print('  recalculs :', page.evaluate('window.__viree.nav.engine.reroutes'), '| hors parcours vu :', saw_off)
        page.wait_for_timeout(1500)
        shot(page, '08-apres-recalcul')

        # Attente de la première pause proposée (simulation très accélérée)
        page.evaluate('window.__viree.nav.sim.setFactor(40)')
        page.wait_for_selector('#nav-sheet [data-act="accept"]', timeout=120000)
        page.evaluate('window.__viree.nav.sim.setFactor(4)')
        shot(page, '09-pause-proposee')
        page.click('#nav-sheet [data-act="accept"]')
        page.wait_for_selector('#nav-sheet [data-act="resume"]', timeout=60000)
        page.wait_for_timeout(1200)
        shot(page, '10-en-pause')
        page.click('#nav-sheet [data-act="resume"]')
        page.wait_for_timeout(1500)
        st = page.evaluate("(() => { const e = window.__viree.nav.engine; return { along: Math.round(e.along), total: Math.round(e.route.totalM), fuel: Math.round(e.fuelLeftKm), stops: e.stops.map(s => s.kind + ':' + s.state) }; })()")
        print('  état :', st)
        page.wait_for_timeout(2000)
        shot(page, '11-navigation-suite')
        # Fin
        page.click('#nav-finish')
        page.click('#nav-sheet [data-act="yes"]')
        page.wait_for_selector('#screen-end.active')
        page.wait_for_timeout(600)
        shot(page, '12-fin')
        print('  fin :', page.inner_text('#end-stats').replace('\n', ' '))
        print('  voix (extraits) :', page.evaluate('(window.__spoken || []).slice(0, 8)'))

        # Trajet A → B
        page.click('#end-new')
        page.click('#mode-ab')
        page.fill('#end-input', 'Pin')
        page.wait_for_selector('[data-place="end"] .suggest button', timeout=5000)
        page.locator('[data-place="end"] .suggest button').first.click()
        page.wait_for_function("() => document.querySelector('#target-out').textContent !== '—'", timeout=10000)
        page.fill('#discovery', '50') if False else page.evaluate("(() => { const r = document.querySelector('#discovery'); r.value = 50; r.dispatchEvent(new Event('input')); })()")
        page.wait_for_timeout(300)
        shot(page, '13-accueil-ab')
        print('  A→B :', page.inner_text('#fast-info'), '| visé', page.inner_text('#target-out'), '| repères', page.inner_text('#ab-ticks').replace('\n', ' '))
        page.click('#go')
        page.wait_for_selector('#screen-list.active', timeout=60000)
        page.wait_for_timeout(300)
        shot(page, '14-liste-ab')
        print('  parcours A→B :', page.locator('.route-name').all_inner_texts(), page.locator('.route-dur').all_inner_texts())

        # Guidage avec la géolocalisation du navigateur (sans le mode simulation)
        page.locator('.route-card').first.click()
        page.wait_for_selector('#detail-updating', state='hidden', timeout=20000)
        shape = page.evaluate('window.__viree.option.route.shape')
        ctx.grant_permissions(['geolocation'])
        ctx.set_geolocation({'latitude': shape[0][0], 'longitude': shape[0][1], 'accuracy': 8})
        page.evaluate("navigator.geolocation.watchPosition(() => {})")
        page.click('#detail-go')
        page.wait_for_selector('#screen-nav.active')
        alongs = []
        for i in range(1, 40):
            pt = shape[min(len(shape) - 1, i * 6)]
            ctx.set_geolocation({'latitude': pt[0], 'longitude': pt[1], 'accuracy': 8})
            page.wait_for_timeout(250)
            alongs.append(page.evaluate('window.__viree.nav ? Math.round(window.__viree.nav.engine.along) : -1'))
        print('  GPS réel — avancée (m) :', alongs[::6], '| manœuvre :', page.inner_text('#man-dist'), page.inner_text('#man-text'))
        shot(page, '16-gps-reel')
        page.click('#nav-finish')
        page.click('#nav-sheet [data-act="yes"]')
        page.wait_for_selector('#screen-end.active')
        page.click('#end-new')

        # Réglages
        page.click('#open-settings')
        page.wait_for_timeout(300)
        shot(page, '15-reglages')
        browser.close()

finally:
    srv.terminate()

print('\nErreurs console :', len(errors))
for e in errors[:20]:
    print('  -', e)
