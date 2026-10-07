import hashlib
import importlib.util
import pathlib
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("artifact", pathlib.Path(__file__).with_name("sealed-qa-artifact.py"))
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)


class ArtifactContract(unittest.TestCase):
    def test_source_and_digest_binding(self):
        source = "1" * 40
        item = dict(id=123, name="morrow-macos-desktop-456", expired=False,
                    workflow_run=dict(id=456, head_sha=source), digest="sha256:" + "a" * 64, size_in_bytes=100)
        self.assertEqual(artifact.select_artifact(dict(artifacts=[item]), source, "456"), item)
        for changed in (dict(expired=True), dict(digest=None), dict(workflow_run=dict(id=456, head_sha="2" * 40))):
            with self.assertRaises((ValueError, TypeError)):
                artifact.select_artifact(dict(artifacts=[dict(item, **changed)]), source, "456")
        with self.assertRaises(ValueError):
            artifact.select_artifact(dict(artifacts=[item, item]), source, "456")

    def fixture(self, directory, name="package-receipt.json", mode=None):
        archive = directory / "artifact.zip"
        member = zipfile.ZipInfo(name)
        if mode is not None:
            member.create_system = 3
            member.external_attr = mode << 16
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr(member, b"{}")
        return archive, dict(size_in_bytes=archive.stat().st_size,
                             digest="sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_exact_archive_extracts(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            archive, metadata = self.fixture(directory)
            artifact.extract_artifact(archive, directory / "out", metadata)
            self.assertEqual((directory / "out/package-receipt.json").read_bytes(), b"{}")

    def test_digest_failure_creates_no_output(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = pathlib.Path(folder)
            archive, metadata = self.fixture(directory)
            archive.write_bytes(archive.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "digest_mismatch"):
                artifact.extract_artifact(archive, directory / "out", metadata)
            self.assertFalse((directory / "out").exists())

    def test_traversal_and_links_are_refused_before_extraction(self):
        for name, mode in (("../outside.json", None), ("/outside.json", None), ("folder/item.json", None),
                           ("C:\\outside.json", None), ("worker.js", None), ("link.json", stat.S_IFLNK | 0o777)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                directory = pathlib.Path(folder)
                archive, metadata = self.fixture(directory, name, mode)
                with self.assertRaisesRegex(ValueError, "member_unsafe"):
                    artifact.extract_artifact(archive, directory / "out", metadata)
                self.assertFalse((directory / "out").exists())


if __name__ == "__main__":
    unittest.main()
