# Homebrew formula template — fill in VERSION, the release URL and the checksums when publishing.
# `brew install <tap>/fornax` installs the macOS binary and the Linux builds it uploads to servers.
class Fornax < Formula
  desc "Provision and run PHP/Laravel servers from a git repo, agent first"
  homepage "https://example.com/fornax"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://example.com/fornax/releases/v#{version}/fornax-#{version}-darwin-arm64.tar.gz"
      sha256 "REPLACE_ME"
    end
    on_intel do
      url "https://example.com/fornax/releases/v#{version}/fornax-#{version}-darwin-x64.tar.gz"
      sha256 "REPLACE_ME"
    end
  end

  def install
    # the tarball contains fornax plus fornax-linux-arm64 and fornax-linux-x64 for servers
    libexec.install Dir["fornax*"]
    bin.install_symlink libexec/"fornax"
  end

  test do
    assert_match "fornax #{version}", shell_output("#{bin}/fornax --version")
  end
end
