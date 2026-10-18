#!/usr/bin/env python3
"""Run the product ZIP extractor's JUnit tests without the Android SDK.

Requires Python 3, a Java runtime, and cached Kotlin 2.2.10/JUnit 4.13.2 jars.
Set ANDROID_ZIP_KOTLIN_CLASSPATH to supply a complete compiler/JUnit classpath.
Missing prerequisites exit 77; product compilation or test failures do not skip.
ANDROID_ZIP_SOURCE can select a different ZipArchive.kt for regression checks.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parent.parent
    java_home = os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    if not java:
        print("ZIP regression prerequisite missing: Java runtime", file=sys.stderr)
        return 77
    compiler_cp = os.environ.get("ANDROID_ZIP_KOTLIN_CLASSPATH")
    if not compiler_cp:
        cache = Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1"
        names = ["kotlin-compiler-embeddable-2.2.10.jar", "kotlin-stdlib-2.2.10.jar",
                 "kotlin-script-runtime-2.2.10.jar", "kotlin-reflect-2.2.10.jar",
                 "kotlinx-coroutines-core-jvm-1.8.0.jar", "annotations-13.0.jar",
                 "junit-4.13.2.jar", "hamcrest-core-1.3.jar"]
        jars = []
        for name in names:
            match = next(cache.rglob(name), None)
            if match is None:
                print("ZIP regression prerequisite missing: " + name +
                      "; supply ANDROID_ZIP_KOTLIN_CLASSPATH or populate the Gradle cache", file=sys.stderr)
                return 77
            jars.append(str(match))
        compiler_cp = os.pathsep.join(jars)
    source = os.environ.get("ANDROID_ZIP_SOURCE", str(root / (
        "android/app/src/main/java/it/airgap/vault/plugin/zip/ZipArchive.kt")))
    tests = root / "android/app/src/test/java/it/airgap/vault/plugin/zip/ZipArchiveTest.kt"
    with tempfile.TemporaryDirectory(prefix="vault-zip-junit-") as output:
        subprocess.run([java, "-cp", compiler_cp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                        "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath", compiler_cp,
                        "-d", output, source, str(tests)], check=True)
        subprocess.run([java, "-cp", output + os.pathsep + compiler_cp,
                        "org.junit.runner.JUnitCore", "it.airgap.vault.plugin.zip.ZipArchiveTest"], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
