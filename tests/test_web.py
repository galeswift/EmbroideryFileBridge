"""Tests for the web UI's JSON API (embroidery-web.py)."""
import io
import json
import os
import time

import pytest

from conftest import mark_synced, upload


def listing(web, path=""):
    res = web.client.get("/api/files", query_string={"path": path})
    assert res.status_code == 200, res.get_json()
    return res.get_json()


def names(data):
    return sorted(e["name"] for e in data["entries"])


def entry(data, name):
    return next(e for e in data["entries"] if e["name"] == name)


# ------------------------------------------------------------- basics

def test_index_and_assets_are_served(web):
    assert web.client.get("/").status_code == 200
    assert b"Embroidery Bridge" in web.client.get("/").data
    assert web.client.get("/static/app.js").status_code == 200
    assert web.client.get("/static/app.css").status_code == 200


def test_empty_listing_has_status(web):
    data = listing(web)
    assert data["path"] == ""
    assert data["entries"] == []
    status = data["status"]
    assert status["pending"] == 0
    assert status["last_sync"] is None
    assert status["disk_free"] > 0 and status["disk_total"] >= status["disk_free"]


def test_status_reports_last_sync_from_state_file(web):
    web.state.write_text(json.dumps({"time": 1700000000, "copied": 2, "failed": 0}))
    assert listing(web)["status"]["last_sync"] == 1700000000


def test_status_tolerates_corrupt_state_file(web):
    web.state.write_text("{not json")
    assert listing(web)["status"]["last_sync"] is None


# ------------------------------------------------------------- upload

def test_upload_single_file_is_pending(web):
    res = upload(web.client, [("rose.pes", b"stitches")])
    assert res.status_code == 200
    assert res.get_json()["saved"] == ["rose.pes"]
    assert (web.staging / "rose.pes").read_bytes() == b"stitches"

    data = listing(web)
    rose = entry(data, "rose.pes")
    assert rose["type"] == "file" and rose["size"] == 8
    assert rose["synced"] is False and rose["design"] is True
    assert data["status"]["pending"] == 1


def test_upload_multiple_files(web):
    res = upload(web.client, [("a.pes", b"1"), ("b.dst", b"22"), ("notes.txt", b"333")])
    assert sorted(res.get_json()["saved"]) == ["a.pes", "b.dst", "notes.txt"]
    data = listing(web)
    assert names(data) == ["a.pes", "b.dst", "notes.txt"]
    assert entry(data, "notes.txt")["design"] is False


def test_upload_into_current_folder(web):
    (web.staging / "Flowers").mkdir()
    upload(web.client, [("rose.pes", b"x")], path="Flowers")
    assert (web.staging / "Flowers" / "rose.pes").exists()


def test_folder_upload_keeps_structure(web):
    res = upload(web.client, [
        ("Holiday/tree.pes", b"t"),
        ("Holiday/Snow/flake.pes", b"f"),
        ("Holiday/Snow/flake2.pes", b"g"),
    ])
    assert len(res.get_json()["saved"]) == 3
    assert (web.staging / "Holiday" / "Snow" / "flake2.pes").exists()

    root = listing(web)
    holiday = entry(root, "Holiday")
    assert holiday["type"] == "folder"
    assert holiday["count"] == 3 and holiday["pending"] == 3
    assert names(listing(web, "Holiday")) == ["Snow", "tree.pes"]


def test_upload_merges_into_existing_folder_ignoring_case(web):
    (web.staging / "Flowers").mkdir()
    upload(web.client, [("flowers/rose.pes", b"x")])
    assert (web.staging / "Flowers" / "rose.pes").exists()
    assert names(listing(web)) == ["Flowers"]


def test_upload_replaces_file_differing_only_in_case(web):
    upload(web.client, [("Rose.pes", b"old")])
    upload(web.client, [("rose.pes", b"new version")])
    assert names(listing(web)) == ["Rose.pes"]
    assert (web.staging / "Rose.pes").read_bytes() == b"new version"


def test_upload_cleans_unsupported_characters(web):
    res = upload(web.client, [("Rosé: bouquet?.pes", b"x")]).get_json()
    assert res["saved"] == ["Rose_ bouquet_.pes"]
    assert res["renamed"] == [["Rosé: bouquet?.pes", "Rose_ bouquet_.pes"]]


def test_upload_skips_names_with_nothing_usable(web):
    res = upload(web.client, [("玫瑰", b"x"), ("ok.pes", b"y")]).get_json()
    assert res["saved"] == ["ok.pes"]
    assert res["skipped"] == ["玫瑰"]


def test_upload_cannot_escape_staging_dir(web):
    res = upload(web.client, [("../../evil.pes", b"x")]).get_json()
    assert res["saved"] == ["evil.pes"]
    assert (web.staging / "evil.pes").exists()
    assert not (web.staging.parent / "evil.pes").exists()


def test_upload_leaves_no_temp_files(web):
    upload(web.client, [("rose.pes", b"x")])
    assert [p.name for p in web.staging.iterdir()] == ["rose.pes"]


def test_reupload_invalidates_synced_marker(web):
    upload(web.client, [("rose.pes", b"aaaa")])
    mark_synced(web, "rose.pes")
    assert entry(listing(web), "rose.pes")["synced"] is True

    upload(web.client, [("rose.pes", b"bbbb")])  # same size, new content
    assert entry(listing(web), "rose.pes")["synced"] is False


def test_upload_too_large_returns_json_error(web):
    web.mod.app.config["MAX_CONTENT_LENGTH"] = 100
    res = upload(web.client, [("big.pes", b"x" * 1000)])
    assert res.status_code == 413
    assert "too large" in res.get_json()["error"]


# --------------------------------------------------------- sync status

def test_synced_requires_matching_size_and_mtime(web):
    upload(web.client, [("rose.pes", b"x")])
    mark_synced(web, "rose.pes")
    assert entry(listing(web), "rose.pes")["synced"] is True

    later = time.time() + 5
    os.utime(web.staging / "rose.pes", (later, later))
    assert entry(listing(web), "rose.pes")["synced"] is False


def test_folder_pending_counts_nested_files(web):
    upload(web.client, [("A/one.pes", b"1"), ("A/B/two.pes", b"2")])
    mark_synced(web, "A/B/two.pes")
    folder = entry(listing(web), "A")
    assert folder["count"] == 2 and folder["pending"] == 1
    assert listing(web)["status"]["pending"] == 1


def test_hidden_and_in_progress_files_are_not_listed(web):
    (web.staging / ".rose.pes.uploading").write_bytes(b"partial")
    (web.staging / "real.pes").write_bytes(b"x")
    assert names(listing(web)) == ["real.pes"]


# ------------------------------------------------------------- folders

def test_mkdir(web):
    res = web.client.post("/api/mkdir", json={"path": "", "name": "Holiday"})
    assert res.status_code == 200 and res.get_json()["path"] == "Holiday"
    assert (web.staging / "Holiday").is_dir()


def test_mkdir_rejects_duplicate_ignoring_case(web):
    (web.staging / "Holiday").mkdir()
    res = web.client.post("/api/mkdir", json={"path": "", "name": "holiday"})
    assert res.status_code == 409


def test_mkdir_rejects_empty_name(web):
    assert web.client.post("/api/mkdir", json={"path": "", "name": "  "}).status_code == 400


def test_folders_lists_whole_tree(web):
    upload(web.client, [("A/x.pes", b"1"), ("A/B/y.pes", b"2"), ("C/z.pes", b"3")])
    assert web.client.get("/api/folders").get_json()["folders"] == ["", "A", "A/B", "C"]


# ------------------------------------------------------ rename & move

def test_rename_file_forgets_marker(web):
    upload(web.client, [("rose.pes", b"x")])
    mark_synced(web, "rose.pes")
    res = web.client.post("/api/rename", json={"path": "rose.pes", "name": "Red Rose.pes"})
    assert res.get_json()["path"] == "Red Rose.pes"
    assert names(listing(web)) == ["Red Rose.pes"]
    # Not yet copied to its new name on the machine.
    assert entry(listing(web), "Red Rose.pes")["synced"] is False
    assert not (web.status / "rose.pes").exists()


def test_rename_case_only(web):
    upload(web.client, [("rose.pes", b"x")])
    res = web.client.post("/api/rename", json={"path": "rose.pes", "name": "Rose.pes"})
    assert res.status_code == 200
    assert names(listing(web)) == ["Rose.pes"]


def test_rename_conflict(web):
    upload(web.client, [("a.pes", b"1"), ("b.pes", b"2")])
    res = web.client.post("/api/rename", json={"path": "a.pes", "name": "B.pes"})
    assert res.status_code == 409


def test_rename_folder(web):
    upload(web.client, [("Old/x.pes", b"1")])
    mark_synced(web, "Old/x.pes")
    web.client.post("/api/rename", json={"path": "Old", "name": "New"})
    assert (web.staging / "New" / "x.pes").exists()
    assert entry(listing(web), "New")["pending"] == 1


def test_rename_root_is_rejected(web):
    assert web.client.post("/api/rename", json={"path": "", "name": "x"}).status_code == 400


def test_move_files_into_folder(web):
    upload(web.client, [("a.pes", b"1"), ("b.pes", b"2")])
    (web.staging / "Box").mkdir()
    mark_synced(web, "a.pes")
    res = web.client.post("/api/move", json={"paths": ["a.pes", "b.pes"], "dest": "Box"}).get_json()
    assert sorted(res["moved"]) == ["Box/a.pes", "Box/b.pes"]
    assert names(listing(web, "Box")) == ["a.pes", "b.pes"]
    assert entry(listing(web, "Box"), "a.pes")["synced"] is False


def test_move_back_to_root(web):
    upload(web.client, [("Box/a.pes", b"1")])
    web.client.post("/api/move", json={"paths": ["Box/a.pes"], "dest": ""})
    assert (web.staging / "a.pes").exists()


def test_move_folder_into_itself_fails(web):
    upload(web.client, [("A/B/x.pes", b"1")])
    res = web.client.post("/api/move", json={"paths": ["A"], "dest": "A/B"}).get_json()
    assert res["moved"] == [] and res["failed"][0][0] == "A"
    assert (web.staging / "A" / "B" / "x.pes").exists()


def test_move_conflict_is_reported(web):
    upload(web.client, [("a.pes", b"1"), ("Box/A.pes", b"2")])
    res = web.client.post("/api/move", json={"paths": ["a.pes"], "dest": "Box"}).get_json()
    assert res["moved"] == [] and len(res["failed"]) == 1
    assert (web.staging / "a.pes").exists()


# -------------------------------------------------------------- delete

def test_delete_files_and_markers(web):
    upload(web.client, [("a.pes", b"1"), ("b.pes", b"2")])
    mark_synced(web, "a.pes")
    res = web.client.post("/api/delete", json={"paths": ["a.pes", "b.pes"]})
    assert sorted(res.get_json()["deleted"]) == ["a.pes", "b.pes"]
    assert listing(web)["entries"] == []
    assert not (web.status / "a.pes").exists()


def test_delete_folder_recursively(web):
    upload(web.client, [("A/x.pes", b"1"), ("A/B/y.pes", b"2")])
    mark_synced(web, "A/B/y.pes")
    web.client.post("/api/delete", json={"paths": ["A"]})
    assert not (web.staging / "A").exists()
    assert not (web.status / "A").exists()


def test_delete_root_is_ignored(web):
    upload(web.client, [("a.pes", b"1")])
    res = web.client.post("/api/delete", json={"paths": [""]}).get_json()
    assert res["deleted"] == []
    assert (web.staging / "a.pes").exists()


# ------------------------------------------------------------ download

def test_download(web):
    upload(web.client, [("Box/rose.pes", b"stitch data")])
    res = web.client.get("/api/download", query_string={"path": "Box/rose.pes"})
    assert res.status_code == 200
    assert res.data == b"stitch data"
    assert "attachment" in res.headers["Content-Disposition"]


def test_download_missing(web):
    assert web.client.get("/api/download", query_string={"path": "nope.pes"}).status_code == 404


# ------------------------------------------------------------- preview

def test_preview_renders_design(web, pes_bytes):
    upload(web.client, [("rose.pes", pes_bytes)])
    res = web.client.get("/api/preview", query_string={"path": "rose.pes"})
    assert res.status_code == 200
    data = res.get_json()
    assert data["svg"].startswith("<svg") and "<polyline" in data["svg"]
    assert data["stitches"] > 50
    assert len(data["colors"]) == 2
    assert all(c.startswith("#") for c in data["colors"])
    assert data["width_mm"] > 0 and data["height_mm"] > 0
    assert (web.previews / "rose.pes.json").exists()


def test_preview_is_cached_until_file_changes(web, pes_bytes, monkeypatch):
    upload(web.client, [("rose.pes", pes_bytes)])
    web.client.get("/api/preview", query_string={"path": "rose.pes"})

    calls = []
    real = web.mod.render_preview
    monkeypatch.setattr(web.mod, "render_preview", lambda p: calls.append(p) or real(p))
    web.client.get("/api/preview", query_string={"path": "rose.pes"})
    assert calls == []  # served from cache

    later = time.time() + 5
    os.utime(web.staging / "rose.pes", (later, later))
    web.client.get("/api/preview", query_string={"path": "rose.pes"})
    assert len(calls) == 1


def test_preview_of_non_design_is_404(web):
    pytest.importorskip("pyembroidery")
    upload(web.client, [("notes.txt", b"hello")])
    assert web.client.get("/api/preview", query_string={"path": "notes.txt"}).status_code == 404


def test_delete_removes_cached_preview(web, pes_bytes):
    upload(web.client, [("Box/rose.pes", pes_bytes)])
    web.client.get("/api/preview", query_string={"path": "Box/rose.pes"})
    assert (web.previews / "Box" / "rose.pes.json").exists()
    web.client.post("/api/delete", json={"paths": ["Box"]})
    assert not (web.previews / "Box").exists()


# ------------------------------------------------------------ security

@pytest.mark.parametrize("path", ["..", "../..", "a/../../x", ".sync-status", "A/.hidden"])
def test_paths_outside_or_hidden_are_rejected(web, path):
    (web.staging / "A").mkdir()
    assert web.client.get("/api/files", query_string={"path": path}).status_code == 400
    assert web.client.post("/api/delete", json={"paths": [path]}).status_code == 400


def test_absolute_path_is_rejected(web):
    target = str(web.staging.parent)
    assert web.client.get("/api/download", query_string={"path": target}).status_code in (400, 404)
    assert web.client.post("/api/delete", json={"paths": [target]}).status_code in (400, 404)
    assert web.staging.parent.exists()


def test_cross_site_post_is_rejected(web):
    upload(web.client, [("a.pes", b"1")])
    res = web.client.post("/api/delete", json={"paths": ["a.pes"]},
                          headers={"Origin": "http://evil.example"})
    assert res.status_code == 403
    assert (web.staging / "a.pes").exists()


def test_same_origin_post_is_allowed(web):
    upload(web.client, [("a.pes", b"1")])
    res = web.client.post("/api/delete", json={"paths": ["a.pes"]},
                          headers={"Origin": "http://localhost"})
    assert res.status_code == 200


def test_listing_a_missing_folder_is_404(web):
    assert web.client.get("/api/files", query_string={"path": "nope"}).status_code == 404


# ------------------------------------------------ machine & drive updates

def set_udc(web, state):
    (web.udc / "20980000.usb").mkdir(parents=True, exist_ok=True)
    (web.udc / "20980000.usb" / "state").write_text(state + "\n")


def test_machine_status_unknown_without_usb_device_mode(web):
    assert listing(web)["status"]["machine"] is None


def test_machine_connected_when_usb_configured(web):
    set_udc(web, "configured")
    assert listing(web)["status"]["machine"] is True


def test_machine_not_connected(web):
    set_udc(web, "not attached")
    assert listing(web)["status"]["machine"] is False


@pytest.mark.parametrize("action", ["upload", "mkdir", "rename", "move", "delete"])
def test_changes_request_a_drive_update(web, action):
    upload(web.client, [("a.pes", b"1")])
    (web.staging / "Box").mkdir()
    web.request.unlink(missing_ok=True)
    if action == "upload":
        upload(web.client, [("b.pes", b"2")])
    elif action == "mkdir":
        web.client.post("/api/mkdir", json={"path": "", "name": "New"})
    elif action == "rename":
        web.client.post("/api/rename", json={"path": "a.pes", "name": "c.pes"})
    elif action == "move":
        web.client.post("/api/move", json={"paths": ["a.pes"], "dest": "Box"})
    elif action == "delete":
        web.client.post("/api/delete", json={"paths": ["a.pes"]})
    assert web.request.exists()


def test_failed_actions_do_not_request_a_drive_update(web):
    upload(web.client, [("a.pes", b"1")])
    web.request.unlink()
    web.client.post("/api/delete", json={"paths": []})
    web.client.post("/api/move", json={"paths": ["a.pes"], "dest": ""})  # already there
    assert not web.request.exists()


def test_only_the_last_batch_of_an_upload_requests_a_drive_update(web):
    res = web.client.post("/api/upload", content_type="multipart/form-data", data={
        "path": "", "final": "0", "file": [(io.BytesIO(b"1"), "a.pes")], "relpath": ["a.pes"]})
    assert res.status_code == 200 and not web.request.exists()
    web.client.post("/api/upload", content_type="multipart/form-data", data={
        "path": "", "final": "1", "file": [(io.BytesIO(b"2"), "b.pes")], "relpath": ["b.pes"]})
    assert web.request.exists()
