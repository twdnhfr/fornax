#!/bin/bash
# The Homebrew formula for a release: scripts/homebrew.sh <version> <owner/repo> <SHA256SUMS> > fornax.rb
# The macOS archives hold fornax plus the Linux builds it uploads to servers; on Linux, Homebrew
# takes the archive of the machine's own architecture.
set -euo pipefail
v="$1"; repo="$2"; sums="$3"
sha() { awk -v f="fornax-$v-$1.tar.gz" '$2 == f {print $1}' "$sums"; }
url() { echo "https://github.com/$repo/releases/download/v$v/fornax-$v-$1.tar.gz"; }
for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do [ -n "$(sha "$t")" ] || { echo "no checksum for $t in $sums" >&2; exit 1; }; done
cat <<EOF
class Fornax < Formula
  desc "Run PHP and Laravel servers from a git repo — self-hosted, agent-first"
  homepage "https://github.com/$repo"
  version "$v"
  license "MIT"

  on_macos do
    on_arm do
      url "$(url darwin-arm64)"
      sha256 "$(sha darwin-arm64)"
    end
    on_intel do
      url "$(url darwin-x64)"
      sha256 "$(sha darwin-x64)"
    end
  end

  on_linux do
    on_arm do
      url "$(url linux-arm64)"
      sha256 "$(sha linux-arm64)"
    end
    on_intel do
      url "$(url linux-x64)"
      sha256 "$(sha linux-x64)"
    end
  end

  def install
    # fornax looks for the Linux builds it uploads to servers next to itself
    libexec.install Dir["fornax*"]
    bin.install_symlink libexec/"fornax"
  end

  test do
    assert_match "fornax #{version}", shell_output("#{bin}/fornax --version")
  end
end
EOF
