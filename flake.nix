{
  description = "Pi extensions and reusable libraries";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      rootManifest = builtins.fromJSON (builtins.readFile ./package.json);
      packageDirectories = builtins.readDir ./packages;
      manifestPath = name: ./packages + "/${name}/package.json";
      packageManifest = name: builtins.fromJSON (builtins.readFile (manifestPath name));
      rootExtensionEntry = name: "./packages/${name}/src/index.ts";
      isExtension =
        name: type:
        type == "directory"
        && builtins.pathExists (manifestPath name)
        && (packageManifest name) ? pi
        && (packageManifest name).pi ? extensions
        && builtins.elem (rootExtensionEntry name) (rootManifest.pi.extensions or [ ]);
      extensionNames = builtins.attrNames (lib.filterAttrs isExtension packageDirectories);
      stableExtensionNames = builtins.filter (
        name: !((packageManifest name).private or false)
      ) extensionNames;
      source = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./package-lock.json
          ./tsconfig.json
          ./packages
        ];
      };

      mkPackages =
        pkgs:
        let
          nodejs = pkgs.nodejs_22;
          rootNpmDeps = pkgs.importNpmLock { npmRoot = source; };
          commonNpmArgs = {
            src = source;
            npmFlags = [ "--legacy-peer-deps" ];
            nativeBuildInputs = [
              nodejs
              pkgs.importNpmLock.npmConfigHook
            ];
          };
          runtimeDependencyCopier = pkgs.writeText "copy-runtime-dependencies.mjs" ''
            import fs from "node:fs";
            import path from "node:path";

            const [packageRootArg, outputModulesArg, overridesArg = "{}"] = process.argv.slice(2);
            const packageRoot = path.resolve(packageRootArg);
            const outputModules = path.resolve(outputModulesArg);
            const overrides = JSON.parse(overridesArg);
            const destinations = new Map();

            function packagePath(name, base) {
              if (overrides[name]) return fs.realpathSync(overrides[name]);
              let directory = fs.realpathSync(base);
              while (true) {
                const candidate = path.join(directory, "node_modules", ...name.split("/"));
                if (fs.existsSync(path.join(candidate, "package.json"))) {
                  return fs.realpathSync(candidate);
                }
                const parent = path.dirname(directory);
                if (parent === directory) throw new Error(`Missing runtime dependency: ''${name}`);
                directory = parent;
              }
            }

            function removeBins(packageOutput, manifest) {
              const bins =
                typeof manifest.bin === "string"
                  ? [manifest.bin]
                  : Object.values(manifest.bin ?? {}).filter((value) => typeof value === "string");
              for (const bin of bins) {
                const target = path.resolve(packageOutput, bin);
                if (target.startsWith(packageOutput + path.sep)) {
                  fs.rmSync(target, { force: true, recursive: true });
                }
              }
            }

            function copyDependency(name, fromRoot, destinationModules, ancestors, optional = false) {
              let sourcePath;
              try {
                sourcePath = packagePath(name, fromRoot);
              } catch (error) {
                if (optional) return;
                throw error;
              }
              if (ancestors.has(sourcePath)) return;
              const destination = path.join(destinationModules, ...name.split("/"));
              const previous = destinations.get(destination);
              if (previous) {
                if (previous !== sourcePath) throw new Error(`Conflicting runtime dependency: ''${name}`);
                return;
              }
              destinations.set(destination, sourcePath);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.cpSync(sourcePath, destination, {
                recursive: true,
                dereference: true,
                filter(source) {
                  const relative = path.relative(sourcePath, source);
                  return relative === "" || relative.split(path.sep)[0] !== "node_modules";
                },
              });
              fs.chmodSync(destination, 0o755);
              const manifest = JSON.parse(fs.readFileSync(path.join(sourcePath, "package.json"), "utf8"));
              removeBins(destination, manifest);
              const nextAncestors = new Set(ancestors).add(sourcePath);
              const nestedModules = path.join(destination, "node_modules");
              for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
                copyDependency(dependency, sourcePath, nestedModules, nextAncestors);
              }
              for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
                copyDependency(dependency, sourcePath, nestedModules, nextAncestors, true);
              }
            }

            const manifest = JSON.parse(
              fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
            );
            fs.mkdirSync(outputModules, { recursive: true });
            for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
              copyDependency(dependency, packageRoot, outputModules, new Set());
            }
          '';

          tuiKitManifest = packageManifest "pi-tui-kit";
          tuiKit = pkgs.stdenv.mkDerivation (
            commonNpmArgs
            // {
              pname = "pi-tui-kit";
              inherit (tuiKitManifest) version;
              npmDeps = rootNpmDeps;

              buildPhase = ''
                runHook preBuild
                npm run --prefix packages/pi-tui-kit build
                runHook postBuild
              '';

              installPhase = ''
                runHook preInstall
                mkdir -p "$out"
                cp packages/pi-tui-kit/package.json "$out/"
                cp -r packages/pi-tui-kit/{dist,README.md,LICENSE} "$out/"
                node "${runtimeDependencyCopier}" packages/pi-tui-kit "$out/node_modules"
                runHook postInstall
              '';
            }
          );

          mkExtension =
            name:
            let
              manifest = packageManifest name;
              publishedFiles =
                manifest.files or [
                  "src"
                  "README.md"
                  "LICENSE"
                ];
              usesTuiKit = builtins.hasAttr "@narumitw/pi-tui-kit" (manifest.dependencies or { });
              runtimeDependencyOverrides = lib.optionalAttrs usesTuiKit {
                "@narumitw/pi-tui-kit" = "${tuiKit}";
              };
              buildOutput =
                if builtins.hasAttr "build" (manifest.scripts or { }) then
                  pkgs.stdenv.mkDerivation (
                    commonNpmArgs
                    // {
                      pname = "${name}-nix-build";
                      inherit (manifest) version;
                      npmDeps = rootNpmDeps;

                      buildPhase = ''
                        runHook preBuild
                        ${lib.optionalString usesTuiKit ''
                          rm -rf node_modules/@narumitw/pi-tui-kit
                          ln -s "${tuiKit}" node_modules/@narumitw/pi-tui-kit
                        ''}
                        npm run --prefix packages/${name} build
                        runHook postBuild
                      '';

                      installPhase = ''
                        runHook preInstall
                        mkdir -p "$out"
                        cp -r "packages/${name}/dist" "$out/dist"
                        runHook postInstall
                      '';
                    }
                  )
                else
                  null;
              copyPublishedFiles = lib.concatMapStringsSep "\n" (
                file:
                if file == "dist" && buildOutput != null then
                  ''
                    cp -r "${buildOutput}/dist" "$out/dist"
                  ''
                else
                  ''
                    cp -r "packages/${name}/${file}" "$out/${file}"
                  ''
              ) publishedFiles;
            in
            pkgs.stdenv.mkDerivation (
              commonNpmArgs
              // {
                pname = name;
                inherit (manifest) version;
                npmDeps = rootNpmDeps;
                dontBuild = true;

                installPhase = ''
                  runHook preInstall
                  mkdir -p "$out"
                  cp "packages/${name}/package.json" "$out/package.json"
                  ${copyPublishedFiles}
                  node "${runtimeDependencyCopier}" \
                    "packages/${name}" \
                    "$out/node_modules" \
                    '${builtins.toJSON runtimeDependencyOverrides}'
                  runHook postInstall
                '';

                passthru = {
                  inherit manifest;
                  lifecycle = if manifest.private or false then "private" else "stable";
                };
                meta = {
                  inherit (manifest) description;
                  homepage = "https://github.com/narumiruna/pi-extensions/tree/main/packages/${name}";
                  license = lib.licenses.mit;
                  platforms = lib.platforms.linux;
                };
              }
            );

          extensionPackages = lib.genAttrs extensionNames mkExtension;
          stablePackageLinks = lib.concatMapStringsSep "\n" (name: ''
            ln -s "${extensionPackages.${name}}" "$out/packages/${name}"
          '') stableExtensionNames;
          stableManifest = rootManifest // {
            pi = (rootManifest.pi or { }) // {
              extensions = map rootExtensionEntry stableExtensionNames;
            };
          };
          stableBundle = pkgs.runCommand "pi-extensions-stable-${rootManifest.version}" { } ''
            mkdir -p "$out/packages"
            cat > "$out/package.json" <<'EOF'
            ${builtins.toJSON stableManifest}
            EOF
            ${stablePackageLinks}
          '';
        in
        extensionPackages
        // {
          default = stableBundle;
          stable-bundle = stableBundle;
        };
    in
    {
      lib = {
        inherit extensionNames stableExtensionNames mkPackages;
      };

      overlays.default =
        final: _prev:
        let
          packages = mkPackages final;
        in
        builtins.removeAttrs packages [
          "default"
          "stable-bundle"
        ]
        // {
          pi-extensions-stable = packages.stable-bundle;
        };

      packages = forAllSystems (system: mkPackages (import nixpkgs { inherit system; }));

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
