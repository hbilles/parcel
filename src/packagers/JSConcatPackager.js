const Packager = require('./Packager');
const path = require('path');
const fs = require('fs');
const SourceMap = require('../SourceMap');
const concat = require('../scope-hoisting/concat');
const lineCounter = require('../utils/lineCounter');
const urlJoin = require('../utils/urlJoin');

const prelude = fs
  .readFileSync(path.join(__dirname, '../builtins/prelude2.min.js'), 'utf8')
  .trim()
  .replace(/;$/, '');
const helpers =
  fs
    .readFileSync(path.join(__dirname, '../builtins/helpers.js'), 'utf8')
    .trim() + '\n';

class JSConcatPackager extends Packager {
  write(string, lineCount = lineCounter(string)) {
    this.lineOffset += lineCount - 1;
    this.contents += string;
  }

  getSize() {
    return this.contents.length;
  }

  async start() {
    this.addedAssets = new Set();
    this.exposedModules = new Set();
    this.externalModules = new Set();
    this.contents = '';
    this.lineOffset = 1;
    this.needsPrelude = false;

    for (let asset of this.bundle.assets) {
      // If this module is referenced by another JS bundle, it needs to be exposed externally.
      let isExposed = !Array.from(asset.parentDeps).every(dep => {
        let depAsset = this.bundler.loadedAssets.get(dep.parent);
        return this.bundle.assets.has(depAsset) || depAsset.type !== 'js';
      });

      if (
        isExposed ||
        (this.bundle.entryAsset === asset &&
          this.bundle.parentBundle &&
          this.bundle.parentBundle.childBundles.size !== 1)
      ) {
        this.exposedModules.add(asset);
        this.needsPrelude = true;
      }

      for (let mod of asset.depAssets.values()) {
        if (
          !this.bundle.assets.has(mod) &&
          this.options.bundleLoaders[asset.type]
        ) {
          this.needsPrelude = true;
          break;
        }
      }
    }

    if (this.bundle.entryAsset) {
      this.markUsedExports(this.bundle.entryAsset);
    }

    if (this.needsPrelude) {
      if (
        this.bundle.entryAsset &&
        this.options.bundleLoaders[this.bundle.entryAsset.type]
      ) {
        this.exposedModules.add(this.bundle.entryAsset);
      }
    }

    this.write(helpers);
  }

  markUsedExports(asset) {
    if (asset.usedExports) {
      return;
    }

    asset.usedExports = new Set();

    for (let identifier in asset.cacheData.imports) {
      let [source, name] = asset.cacheData.imports[identifier];
      let dep = asset.depAssets.get(asset.dependencies.get(source));
      this.markUsed(dep, name);
    }
  }

  markUsed(mod, id) {
    let exp = mod.cacheData.exports[id];
    if (Array.isArray(exp)) {
      let depMod = mod.depAssets.get(mod.dependencies.get(exp[0]));
      return this.markUsed(depMod, exp[1]);
    }

    this.markUsedExports(mod);
    mod.usedExports.add(id);
  }

  getExportIdentifier(asset) {
    return '$' + asset.id + '$exports';
  }

  async addAsset(asset) {
    if (this.addedAssets.has(asset)) {
      return;
    }
    this.addedAssets.add(asset);
    let {js, map} = asset.generated;

    // If the asset's package has the sideEffects: false flag set, and there are no used
    // exports marked, exclude the asset from the bundle.
    if (
      asset.cacheData.sideEffects === false &&
      (!asset.usedExports || asset.usedExports.size === 0)
    ) {
      return;
    }

    for (let [dep, mod] of asset.depAssets) {
      if (dep.dynamic && this.bundle.childBundles.has(mod.parentBundle)) {
        for (let child of mod.parentBundle.siblingBundles) {
          if (!child.isEmpty) {
            await this.addBundleLoader(child.type);
          }
        }

        await this.addBundleLoader(mod.type, true);
      } else {
        // If the dep isn't in this bundle, add it to the list of external modules to preload.
        // Only do this if this is the root JS bundle, otherwise they will have already been
        // loaded in parallel with this bundle as part of a dynamic import.
        if (
          !this.bundle.assets.has(mod) &&
          (!this.bundle.parentBundle ||
            this.bundle.parentBundle.type !== 'js') &&
          this.options.bundleLoaders[mod.type]
        ) {
          this.externalModules.add(mod);
          await this.addBundleLoader(mod.type);
        }
      }
    }

    if (this.bundle.entryAsset === asset && this.externalModules.size > 0) {
      js = `
        function $parcel$entry() {
          ${js.trim()}
        }
      `;
    }

    js = js.trim() + '\n';

    this.bundle.addOffset(asset, this.lineOffset + 1);
    this.write(
      `\n// ASSET: ${asset.id} - ${path.relative(
        this.options.rootDir,
        asset.name
      )}\n${js}`,
      map && map.lineCount ? map.lineCount : undefined
    );
  }

  getBundleSpecifier(bundle) {
    let name = path.basename(bundle.name);
    if (bundle.entryAsset) {
      return [name, bundle.entryAsset.id];
    }

    return name;
  }

  async addAssetToBundle(asset) {
    if (this.bundle.assets.has(asset)) {
      return;
    }
    this.bundle.addAsset(asset);
    if (!asset.parentBundle) {
      asset.parentBundle = this.bundle;
    }

    // Add all dependencies as well
    for (let child of asset.depAssets.values()) {
      await this.addAssetToBundle(child, this.bundle);
    }

    await this.addAsset(asset);
  }

  async addBundleLoader(bundleType, dynamic) {
    let loader = this.options.bundleLoaders[bundleType];
    if (!loader) {
      return;
    }

    let bundleLoader = this.bundler.loadedAssets.get(
      require.resolve('../builtins/bundle-loader')
    );
    if (!bundleLoader && !dynamic) {
      bundleLoader = await this.bundler.getAsset('_bundle_loader');
    }

    if (bundleLoader) {
      await this.addAssetToBundle(bundleLoader);
    } else {
      return;
    }

    let target = this.options.target === 'node' ? 'node' : 'browser';
    let asset = await this.bundler.getAsset(loader[target]);
    if (!this.bundle.assets.has(asset)) {
      await this.addAssetToBundle(asset);
      this.write(
        `${this.getExportIdentifier(bundleLoader)}.register(${JSON.stringify(
          bundleType
        )},${this.getExportIdentifier(asset)});\n`
      );
    }
  }

  async end() {
    // Preload external modules before running entry point if needed
    if (this.externalModules.size > 0) {
      let bundleLoader = this.bundler.loadedAssets.get(
        require.resolve('../builtins/bundle-loader')
      );

      let preload = [];
      for (let mod of this.externalModules) {
        // Find the bundle that has the module as its entry point
        let bundle = Array.from(mod.bundles).find(b => b.entryAsset === mod);
        if (bundle) {
          preload.push([path.basename(bundle.name), mod.id]);
        }
      }

      let loads = `${this.getExportIdentifier(
        bundleLoader
      )}.load(${JSON.stringify(preload)})`;
      if (this.bundle.entryAsset) {
        loads += '.then($parcel$entry)';
      }

      loads += ';';
      this.write(loads);
    }

    let entryExports =
      this.bundle.entryAsset &&
      this.getExportIdentifier(this.bundle.entryAsset);
    if (
      entryExports &&
      this.bundle.entryAsset.generated.js.includes(entryExports)
    ) {
      this.write(`
        if (typeof exports === "object" && typeof module !== "undefined") {
          // CommonJS
          module.exports = ${entryExports};
        } else if (typeof define === "function" && define.amd) {
          // RequireJS
          define(function () {
            return ${entryExports};
          });
        } ${
          this.options.global
            ? `else {
          // <script>
          this[${JSON.stringify(this.options.global)}] = ${entryExports};
        }`
            : ''
        }
      `);
    }

    if (this.needsPrelude) {
      let exposed = [];
      let prepareModule = [];
      for (let m of this.exposedModules) {
        if (m.cacheData.isES6Module) {
          prepareModule.push(
            `${this.getExportIdentifier(m)}.__esModule = true;`
          );
        }

        exposed.push(`${m.id}: ${this.getExportIdentifier(m)}`);
      }

      this.write(`
        ${prepareModule.join('\n')}
        return {${exposed.join(', ')}};
      `);
    }

    let {code: output, rawMappings} = concat(this);

    if (!this.options.minify) {
      output = '\n' + output + '\n';
    }

    if (this.needsPrelude) {
      output = prelude + '(function (require) {' + output + '});';
    } else {
      output = '(function () {' + output + '})();';
    }

    this.bundle.totalSize = output.length;

    let {sourceMaps} = this.options;
    if (sourceMaps && rawMappings) {
      this.bundle.extendSourceMap(
        new SourceMap(rawMappings, {
          [this.bundle.name]: this.contents
        })
      );
    }

    if (sourceMaps) {
      // Add source map url if a map bundle exists
      let mapBundle = this.bundle.siblingBundlesMap.get('map');
      if (mapBundle) {
        output += `\n//# sourceMappingURL=${urlJoin(
          this.options.publicURL,
          path.basename(mapBundle.name)
        )}`;
      }
    }

    await super.write(output);
  }
}

module.exports = JSConcatPackager;
