import { describe, expect, test } from "bun:test";
import { forgeBuildCommands } from "../../src/forge/convert.ts";

describe("Forge deploy scripts as build commands", () => {
  test("an in-place Laravel script keeps its build, loses fetch and FPM reload", () => {
    const t = forgeBuildCommands(`cd $FORGE_SITE_PATH
git pull origin $FORGE_SITE_BRANCH

$FORGE_COMPOSER install --no-dev --no-interaction --prefer-dist --optimize-autoloader

( flock -w 10 9 || exit 1
    echo 'Restarting FPM...'; sudo -S service $FORGE_PHP_FPM reload ) 9>/tmp/fpmlock

if [ -f artisan ]; then
    $FORGE_PHP artisan migrate --force
fi
`);
    expect(t.commands).toBe(`$FORNAX_COMPOSER install --no-dev --no-interaction --prefer-dist --optimize-autoloader

if [ -f artisan ]; then
    $FORNAX_PHP artisan migrate --force
fi`);
    expect(t.dropped.map((l) => l.trim())).toEqual([
      "cd $FORGE_SITE_PATH",
      "git pull origin $FORGE_SITE_BRANCH",
      "( flock -w 10 9 || exit 1",
      "echo 'Restarting FPM...'; sudo -S service $FORGE_PHP_FPM reload ) 9>/tmp/fpmlock",
    ]);
    expect(t.unknown).toEqual([]);
  });

  test("a static build stays as it is; unknown Forge variables are reported", () => {
    const t = forgeBuildCommands("cd $FORGE_SITE_PATH\ngit pull origin $FORGE_SITE_BRANCH\ncomposer install --no-dev\nphp build.php --env=$FORGE_SITE_BRANCH\n");
    expect(t.commands).toBe("composer install --no-dev\nphp build.php --env=$FORGE_SITE_BRANCH");
    expect(t.unknown).toEqual(["$FORGE_SITE_BRANCH"]);
  });
});

describe("zero-downtime Forge scripts", () => {
  test("release macros and restarts go, the steps stay in Forge's order", () => {
    const t = forgeBuildCommands(`$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

$FORGE_COMPOSER install --no-dev --no-interaction --prefer-dist --optimize-autoloader
$FORGE_PHP artisan optimize
$FORGE_PHP artisan migrate --force

$ACTIVATE_RELEASE()

$RESTART_QUEUES()

$FORGE_PHP artisan queue:restart
$FORGE_PHP artisan reverb:restart`);
    expect(t.commands).toBe("$FORNAX_COMPOSER install --no-dev --no-interaction --prefer-dist --optimize-autoloader\n$FORNAX_PHP artisan optimize\n$FORNAX_PHP artisan migrate --force");
    expect(t.afterActivation).toEqual([]);
  });

  test("the site path spelled out becomes $FORNAX_SITE_PATH", () => {
    const t = forgeBuildCommands("$CREATE_RELEASE()\nSHARED=/home/shop/shop.example.com/storage\nln -s \"$SHARED\" storage\n$ACTIVATE_RELEASE()", "/home/shop/shop.example.com");
    expect(t.commands).toBe('SHARED=$FORNAX_SITE_PATH/storage\nln -s "$SHARED" storage');
  });

  test("other commands after activation are reported, release paths are fornax's", () => {
    const t = forgeBuildCommands("$CREATE_RELEASE()\ncd $FORGE_RELEASE_DIRECTORY\nls $FORGE_RELEASE_DIRECTORY\n$ACTIVATE_RELEASE()\ncurl -s https://example.com/ping");
    expect(t.commands).toBe("ls $FORNAX_RELEASE_PATH\ncurl -s https://example.com/ping");
    expect(t.afterActivation).toEqual(["curl -s https://example.com/ping"]);
  });
});
