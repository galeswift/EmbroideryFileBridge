"""End-to-end tests that drive the real page in a headless browser.

Skipped unless Playwright is installed (pip install playwright) and a
Chromium browser is available: either Playwright's own
(`python -m playwright install chromium`) or an installed Google Chrome.
"""
import threading

import pytest

from conftest import load_web, make_pes, mark_synced

sync_api = pytest.importorskip("playwright.sync_api")
from werkzeug.serving import make_server  # noqa: E402


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as p:
        last_error = None
        for kwargs in ({}, {"channel": "chrome"}):
            try:
                # A software GPU, so the WebGL stitch renderer runs headless.
                b = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-angle=swiftshader"], **kwargs)
                break
            except Exception as err:  # browser not installed
                last_error = err
        else:
            pytest.skip(f"no Chromium browser available: {last_error}")
        yield b
        b.close()


@pytest.fixture
def site(tmp_path, monkeypatch, browser):
    web = load_web(tmp_path, monkeypatch)
    server = make_server("127.0.0.1", 0, web.mod.app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    web.url = f"http://127.0.0.1:{server.server_port}/"
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    web.page = ctx.new_page()
    web.errors = []
    web.page.on("pageerror", lambda e: web.errors.append(str(e)))
    web.page.set_default_timeout(10000)
    yield web
    ctx.close()
    server.shutdown()
    assert web.errors == [], f"JavaScript errors: {web.errors}"


def open_page(site, path=""):
    site.page.goto(site.url + (f"#/{path}" if path else ""))
    site.page.wait_for_selector("#items:not([hidden]), #empty:not([hidden])")


def card(site, name):
    return site.page.locator(".card", has=site.page.locator(".name", has_text=name))


def card_names(site):
    return sorted(site.page.locator(".card .name").all_inner_texts())


def test_upload_via_button(site, tmp_path):
    f1 = tmp_path / "rose.pes"
    f1.write_bytes(b"rose")
    f2 = tmp_path / "daisy.dst"
    f2.write_bytes(b"daisy")
    open_page(site)
    assert site.page.is_visible("#empty")
    site.page.set_input_files("#file-input", [str(f1), str(f2)])
    card(site, "rose.pes").wait_for()
    card(site, "daisy.dst").wait_for()
    assert card(site, "rose.pes").locator(".chip.wait").is_visible()
    assert (site.staging / "rose.pes").read_bytes() == b"rose"


def test_synced_badge(site):
    (site.staging / "rose.pes").write_bytes(b"x")
    mark_synced(site, "rose.pes")
    open_page(site)
    assert card(site, "rose.pes").locator(".chip.ok").is_visible()


def test_viewer_shows_design_details(site, pes_bytes):
    (site.staging / "rose.pes").write_bytes(pes_bytes)
    open_page(site)
    card(site, "rose.pes").locator(".thumb svg").wait_for()  # thumbnail rendered
    card(site, "rose.pes").click()
    site.page.wait_for_selector("#viewer[open] #viewer-facts .swatch")
    facts = site.page.inner_text("#viewer-facts")
    assert "Stitches" in facts and "Design size" in facts
    assert site.page.locator("#viewer-facts .swatch").count() == 2


def test_new_folder_with_enter_key(site):
    open_page(site)
    site.page.click("#new-folder")
    site.page.fill("#ask-input", "Holiday")
    site.page.keyboard.press("Enter")
    card(site, "Holiday").wait_for()
    assert (site.staging / "Holiday").is_dir()


def test_navigate_into_folder_and_back(site):
    (site.staging / "Holiday").mkdir()
    (site.staging / "Holiday" / "tree.pes").write_bytes(b"t")
    open_page(site)
    card(site, "Holiday").click()
    card(site, "tree.pes").wait_for()
    assert "Holiday" in site.page.inner_text("#crumbs")
    site.page.click("#crumbs button >> text=All designs")
    card(site, "Holiday").wait_for()


def test_folder_card_shows_its_designs(site):
    for name in ("a.pes", "b.pes", "c.pes"):
        make_pes(site.staging / "Holiday" / name)
    (site.staging / "Notes").mkdir()
    (site.staging / "Notes" / "readme.txt").write_bytes(b"x")
    open_page(site)
    holiday = card(site, "Holiday")
    holiday.locator(".collage .tile svg").nth(2).wait_for()
    assert holiday.locator(".collage .tile").count() == 3
    assert holiday.locator(".folder-badge").is_visible()
    assert not holiday.locator(".thumb > .ph").is_visible()
    # A folder without designs keeps the plain folder icon.
    assert card(site, "Notes").locator(".collage").count() == 0
    assert card(site, "Notes").locator(".thumb > .ph").is_visible()


def test_folder_collage_is_hidden_in_list_view(site):
    make_pes(site.staging / "Holiday" / "a.pes")
    open_page(site)
    site.page.click("#view-list")
    holiday = card(site, "Holiday")
    assert not holiday.locator(".collage").is_visible()
    assert holiday.locator(".thumb > .ph").is_visible()


def test_rename_from_viewer(site):
    (site.staging / "rose.pes").write_bytes(b"x")
    open_page(site)
    card(site, "rose.pes").click()
    site.page.click("#viewer-rename")
    site.page.fill("#ask-input", "Red rose.pes")
    site.page.keyboard.press("Enter")
    site.page.wait_for_function("document.querySelector('#viewer-name').textContent === 'Red rose.pes'")
    assert (site.staging / "Red rose.pes").exists()


def test_multiselect_and_move(site):
    for name in ("a.pes", "b.pes", "c.pes"):
        (site.staging / name).write_bytes(b"x")
    (site.staging / "Box").mkdir()
    open_page(site)
    card(site, "a.pes").locator(".check").click(force=True)
    card(site, "c.pes").locator(".check").click(force=True)
    assert site.page.inner_text("#selection-count") == "2 selected"
    site.page.click("#sel-move")
    site.page.click("#ask-list button >> text=Box")
    site.page.click("#ask-ok")
    site.page.wait_for_function("document.querySelectorAll('.card').length === 2")
    assert sorted(p.name for p in (site.staging / "Box").iterdir()) == ["a.pes", "c.pes"]


def test_shift_click_selects_range(site):
    for name in ("a.pes", "b.pes", "c.pes", "d.pes"):
        (site.staging / name).write_bytes(b"x")
    open_page(site)
    card(site, "a.pes").locator(".check").click(force=True)
    card(site, "c.pes").locator(".check").click(force=True, modifiers=["Shift"])
    assert site.page.inner_text("#selection-count") == "3 selected"


def test_select_all_and_delete_with_keyboard(site):
    for name in ("a.pes", "b.pes"):
        (site.staging / name).write_bytes(b"x")
    open_page(site)
    site.page.keyboard.press("Control+a")
    assert site.page.inner_text("#selection-count") == "2 selected"
    site.page.keyboard.press("Delete")
    site.page.wait_for_selector("#ask[open]")
    site.page.click("#ask-ok")
    site.page.wait_for_selector("#empty:not([hidden])")
    assert list(site.staging.iterdir()) == []


def test_cancel_delete_keeps_files(site):
    (site.staging / "a.pes").write_bytes(b"x")
    open_page(site)
    card(site, "a.pes").locator(".check").click(force=True)
    site.page.click("#sel-delete")
    site.page.click("#ask button[value=cancel]")
    assert (site.staging / "a.pes").exists()


def test_search_filters_current_folder(site):
    for name in ("rose.pes", "daisy.pes", "rosebud.pes"):
        (site.staging / name).write_bytes(b"x")
    open_page(site)
    site.page.fill("#search", "rose")
    assert card_names(site) == ["rose.pes", "rosebud.pes"]
    site.page.fill("#search", "zzz")
    assert site.page.inner_text("#empty-title") == "No matches"


def test_list_view_is_remembered(site):
    (site.staging / "a.pes").write_bytes(b"x")
    open_page(site)
    site.page.click("#view-list")
    site.page.reload()
    site.page.wait_for_selector("#items.list")


def test_big_upload_is_sent_in_batches(site, tmp_path):
    site.page.add_init_script("window.UPLOAD_BATCH_BYTES = 10")
    files = []
    for name in ("a.pes", "b.pes", "c.pes"):
        f = tmp_path / name
        f.write_bytes(b"0123456789")  # one batch each
        files.append(str(f))
    requests = []
    site.page.on("request", lambda r: r.url.endswith("/api/upload") and requests.append(r))
    open_page(site)
    site.page.set_input_files("#file-input", files)
    site.page.wait_for_selector(".toast >> text=Uploaded 3 files")
    assert len(requests) == 3
    assert card_names(site) == ["a.pes", "b.pes", "c.pes"]
    assert site.request.exists()  # the last batch asked for a drive update


def test_failed_batch_is_reported_and_the_rest_still_upload(site, tmp_path):
    site.page.add_init_script("window.UPLOAD_BATCH_BYTES = 10")
    files = []
    for name in ("a.pes", "b.pes", "c.pes"):
        f = tmp_path / name
        f.write_bytes(b"0123456789")
        files.append(str(f))

    def fail_b(route):
        if b'filename="b.pes"' in (route.request.post_data_buffer or b""):
            route.abort()
        else:
            route.continue_()

    site.page.route("**/api/upload", fail_b)
    open_page(site)
    site.page.set_input_files("#file-input", files)
    site.page.wait_for_selector(".toast.error >> text=didn't upload")
    assert "b.pes" in site.page.inner_text(".toast.error")
    assert card_names(site) == ["a.pes", "c.pes"]


def test_oversized_design_gets_a_too_big_badge(site):
    make_pes(site.staging / "Banner.pes", width_mm=550)
    make_pes(site.staging / "Small.pes", width_mm=40)
    open_page(site)
    card(site, "Small.pes").locator(".thumb svg").wait_for()
    badge = card(site, "Banner.pes").locator(".too-big")
    badge.wait_for()
    assert "Too big" in badge.inner_text()
    tip = badge.get_attribute("title")
    assert "too big for your machine" in tip and "200 × 200 mm" in tip
    assert card(site, "Small.pes").locator(".too-big").count() == 0


def test_viewer_warns_about_oversized_design(site):
    make_pes(site.staging / "Banner.pes", width_mm=550)
    open_page(site)
    card(site, "Banner.pes").locator(".too-big").wait_for()
    card(site, "Banner.pes").click()
    site.page.wait_for_selector("#viewer[open] .warn-text")
    assert "won't show up on the machine" in site.page.inner_text("#viewer-facts")


def test_design_that_fits_says_so(site):
    make_pes(site.staging / "Small.pes", width_mm=40)
    open_page(site)
    card(site, "Small.pes").click()
    site.page.wait_for_selector("#viewer[open] #viewer-facts .swatch")
    assert "Fits the 200 × 200 mm hoop" in site.page.inner_text("#viewer-facts")


# ------------------------------------------------------ stitch renderer

# Share of the canvas that isn't plain fabric (the top-left pixel).
THREAD_COVERAGE_JS = """() => {
  const src = document.querySelector('.stitch-view canvas');
  const c = document.createElement('canvas');
  c.width = 200; c.height = 200;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, 200, 200);
  const d = ctx.getImageData(0, 0, 200, 200).data;
  let differ = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 60) differ++;
  }
  return differ / (d.length / 4);
}"""


def open_stitches(site, name):
    open_page(site)
    card(site, name).click()
    site.page.wait_for_selector("#viewer-art[data-stage=stitches] .stitch-view[data-rendered]")
    return site.page.locator(".stitch-view")


def test_viewer_draws_the_stitches(site):
    make_pes(site.staging / "rose.pes")
    view = open_stitches(site, "rose.pes")
    assert view.get_attribute("data-renderer") in ("webgl", "canvas")
    assert 0.02 < site.page.evaluate(THREAD_COVERAGE_JS) < 0.9


STACK_SATIN_JS = """() => {
  // A satin column: 400 stitches zigzagging across 4 mm, 0.1 mm apart...
  const segs = [];
  for (let i = 0; i < 400; i++) {
    const y = i * 0.1;
    segs.push(i % 2 ? 4 : 0, y, i % 2 ? 0 : 4, y + 0.1, 0.5);
  }
  // ...then one long stitch sewn over it, along the column.
  segs.push(2, -1, 2.2, 41, 0.5);
  const n = segs.length / 5;
  const st = StitchView.stack({ width: 5, height: 42, segments: new Float32Array(segs), segmentCount: n });
  const top = (i) => st.instances[i * 8 + 6];
  let satin = 0;
  for (let i = 0; i < 400; i++) satin = Math.max(satin, top(i));
  return { satin, over: top(400), maxZ: st.maxZ };
}"""


def test_stacking_satin_lies_flat_and_later_stitches_lie_on_top(site):
    open_page(site)
    z = site.page.evaluate(STACK_SATIN_JS)
    assert z["satin"] < 0.2  # side by side, not climbing each other
    assert z["over"] > z["satin"] + 0.05  # resting on the satin
    assert z["maxZ"] < 1


def test_viewer_uses_webgl_when_available(site):
    has_webgl = site.page.evaluate("!!document.createElement('canvas').getContext('webgl2')")
    if not has_webgl:
        pytest.skip("no WebGL2 in this browser")
    make_pes(site.staging / "rose.pes")
    assert open_stitches(site, "rose.pes").get_attribute("data-renderer") == "webgl"


def test_viewer_falls_back_to_a_2d_canvas(site):
    site.page.add_init_script("window.FORCE_CANVAS_RENDERER = true")
    make_pes(site.staging / "rose.pes")
    assert open_stitches(site, "rose.pes").get_attribute("data-renderer") == "canvas"
    assert 0.02 < site.page.evaluate(THREAD_COVERAGE_JS) < 0.9


def test_viewer_zooms_and_double_click_fits_again(site):
    make_pes(site.staging / "rose.pes")
    view = open_stitches(site, "rose.pes")
    assert "zoom" in site.page.inner_text(".stitch-hint")
    view.hover()
    for _ in range(5):
        site.page.mouse.wheel(0, -200)
    site.page.wait_for_function("document.querySelector('.stitch-view').dataset.zoom > 3")
    assert "fit" in site.page.inner_text(".stitch-hint")
    view.dblclick()
    site.page.wait_for_function("document.querySelector('.stitch-view').dataset.zoom === '1.00'")


def test_status_refresh_keeps_the_zoom(site):
    make_pes(site.staging / "rose.pes")
    view = open_stitches(site, "rose.pes")
    view.hover()
    for _ in range(5):
        site.page.mouse.wheel(0, -200)
    site.page.wait_for_function("document.querySelector('.stitch-view').dataset.zoom > 3")
    site.page.evaluate("showViewer(viewer.index)")  # what a status poll does
    site.page.wait_for_timeout(100)
    assert float(view.get_attribute("data-zoom")) > 3


def test_viewer_moves_to_the_next_design(site):
    make_pes(site.staging / "a.pes", width_mm=40)
    make_pes(site.staging / "b.pes", width_mm=150)
    open_stitches(site, "a.pes")
    site.page.keyboard.press("ArrowRight")
    site.page.wait_for_function("document.querySelector('#viewer-art').dataset.key.startsWith('b.pes|')")
    site.page.wait_for_selector("#viewer-art[data-stage=stitches]")
    assert site.page.inner_text("#viewer-name") == "b.pes"
