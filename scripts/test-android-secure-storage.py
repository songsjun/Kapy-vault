#!/usr/bin/env python3
"""Compile the real storage classes and run their JVM fault-injection tests.

Requires Python 3, JDK 17 (java/javac on PATH or JAVA_HOME), and the Kotlin
2.2.10 compiler dependencies downloaded by the Android Gradle build. No network
access or Android SDK is needed. Set ANDROID_STORAGE_KOTLIN_COMPILER_CLASSPATH
to use a separate complete compiler classpath. Missing prerequisites exit 77 so
the Node test suite reports an explicit skip instead of silently omitting them.

Android Keystore and POSIX rename boundaries are simulated. AES, file I/O,
FileDescriptor.sync(), and the product Kotlin classes execute without mocks.
ANDROID_STORAGE_SOURCE_DIR can point to another copy of the four product files
to verify that the regression test fails against an older version.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def prerequisite(message):
    print("Native storage test prerequisite missing: " + message, file=sys.stderr)
    raise SystemExit(77)


def main():
    root = Path(__file__).resolve().parent.parent
    fixtures = root / "tests/native-storage"
    source = Path(os.environ.get("ANDROID_STORAGE_SOURCE_DIR", str(root / (
        "android/app/src/main/java/it/airgap/vault/plugin/securityutils/storage"))))
    java_home = os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin/java") if java_home else shutil.which("java")
    javac = str(Path(java_home) / "bin/javac") if java_home else shutil.which("javac")
    if not java or not javac:
        prerequisite("JDK 17 with java and javac")

    compiler_cp = os.environ.get("ANDROID_STORAGE_KOTLIN_COMPILER_CLASSPATH")
    if not compiler_cp:
        cache = Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1"
        names = ["kotlin-compiler-embeddable-2.2.10.jar", "kotlin-stdlib-2.2.10.jar",
                 "kotlin-script-runtime-2.2.10.jar", "kotlin-reflect-2.2.10.jar",
                 "kotlinx-coroutines-core-jvm-1.8.0.jar", "annotations-13.0.jar"]
        jars = []
        for name in names:
            matches = list(cache.rglob(name))
            if not matches:
                prerequisite(name + "; run the Android Gradle build or supply ANDROID_STORAGE_KOTLIN_COMPILER_CLASSPATH")
            jars.append(str(matches[0]))
        compiler_cp = os.pathsep.join(jars)

    with tempfile.TemporaryDirectory(prefix="airgap-storage-regression-") as temporary:
        output = Path(temporary) / "classes"
        output.mkdir()
        subprocess.run([javac, "-d", str(output), *map(str, fixtures.rglob("*.java"))], check=True)
        runtime_cp = str(output) + os.pathsep + compiler_cp
        subprocess.run([java, "-cp", compiler_cp, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler",
                        "-no-stdlib", "-no-reflect", "-jvm-target", "17", "-classpath", runtime_cp,
                        "-d", str(output), str(fixtures / "StorageRegression.kt"),
                        *[str(source / name) for name in (
                            "SecureFile.kt", "SecureFileStorage.kt", "Constants.kt", "Errors.kt")]], check=True)
        subprocess.run([java, "-cp", runtime_cp, "StorageRegressionKt", str(Path(temporary) / "data")], check=True)


if __name__ == "__main__":
    main()
