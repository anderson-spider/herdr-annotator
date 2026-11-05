import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo, self.home, self.app = base / "repo", base / "home", base / "app"
        (self.repo / "scripts").mkdir(parents=True)
        source = Path(__file__).resolve().parents[1]
        for name in ["install.py", "tabs_integration.py", "update.py"]:
            shutil.copy2(source / "scripts" / name, self.repo / "scripts" / name)
        mod = self.repo / "mods/annotator"
        mod.mkdir(parents=True)
        for name in ["main.js", "review.js", "full.js", "syntax.js", "draft.js", "github-refresh.js", "updates.js", "launcher.js"]:
            (mod / name).write_text(f"// {name}\n")
        (mod / "mod.json").write_text(json.dumps({"version": "0.2.0"}))
        (self.repo / ".gitignore").write_text("target/\n__pycache__/\n")
        (self.repo / "source.txt").write_text("original")
        (self.repo / "target/release").mkdir(parents=True)
        (self.repo / "target/release/herdr-annotator").write_text("helper binary")
        (self.app / "mods/tabs").mkdir(parents=True)
        (self.app / "mods/tabs/main.js").write_text('.when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))')
        (self.app / "layouts").mkdir()
        for name in ["one", "two"]:
            (self.app / "layouts" / f"{name}.json").write_text(json.dumps({"children": [
                {"content": {"mod": "tabs"}}, {"content": {"mod": "changes"}}]}))
        commands = base / "bin"
        commands.mkdir()
        for name, text in [("cargo", '#!/bin/sh\nif [ "$FAKE_EDIT_SOURCE" = "1" ]; then echo changed >> source.txt; fi\nexit 0\n'),
                           ("herdr-app", "#!/bin/sh\nexit 0\n")]:
            path = commands / name
            path.write_text(text)
            path.chmod(0o700)
        self.env = {**os.environ, "HOME": str(self.home), "HERDR_APP_HOME": str(self.app), "PATH": str(commands) + os.pathsep + os.environ["PATH"]}
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "source")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, check=True).stdout.strip()

    def install(self, *args, env=None):
        return subprocess.run([sys.executable, "scripts/install.py", *args], cwd=self.repo,
                              env=env or self.env, capture_output=True, text=True)

    def receipt(self):
        return json.loads((self.home / ".local/share/herdr-annotator/install.json").read_text())

    def test_install_remembers_all_layouts_and_updates_private_tabs_without_rewriting_layouts(self):
        first = self.install("--layout", "one", "--layout", "two", "--gitlab-host", "Git.Example.com")
        self.assertEqual(first.returncode, 0, first.stderr)
        receipt = self.receipt()
        self.assertEqual(receipt["layouts"], ["one", "two"])
        self.assertEqual(receipt["gitlab_hosts"], ["git.example.com"])
        self.assertEqual(receipt["version"], "0.2.0")
        self.assertTrue(receipt["binary_digest"])
        self.assertTrue(receipt["updater_digest"])
        layouts = {path: path.read_bytes() for path in (self.app / "layouts").glob("*.json")}
        second = self.install()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.receipt()["layouts"], ["one", "two"])
        self.assertEqual(self.receipt()["gitlab_hosts"], ["git.example.com"])
        self.assertEqual(layouts, {path: path.read_bytes() for path in layouts})
        self.assertTrue(list((self.home / ".local/share/herdr-annotator/backups").glob("*/install.json")))

    def test_modified_helper_and_updater_are_refused_before_replacing_mods(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        for path in [self.home / ".local/bin/herdr-annotator", self.home / ".local/share/herdr-annotator/update.py"]:
            original = path.read_bytes()
            path.write_text("local edit")
            result = self.install()
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(path.read_text(), "local edit")
            path.write_bytes(original)

    def test_release_source_edit_during_build_prevents_all_install_writes(self):
        sha = self.git("rev-parse", "HEAD")
        result = self.install("--expected-commit", sha, env={**self.env, "FAKE_EDIT_SOURCE": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed during the update", result.stderr)
        self.assertFalse((self.home / ".local/bin/herdr-annotator").exists())
        self.assertFalse((self.app / "mods/annotator").exists())
        self.assertIn("changed", (self.repo / "source.txt").read_text())


if __name__ == "__main__":
    unittest.main()
