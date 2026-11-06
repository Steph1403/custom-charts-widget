import React, {Component} from 'react';
import plotly from 'plotly.js/dist/plotly';
import PlotlyEditor, {Button} from 'react-chart-editor';
import 'react-chart-editor/lib/react-chart-editor.css';
import {produce, setAutoFreeze} from "immer"
import 'react-chart-editor/lib/react-chart-editor.min.css'
import {CogIcon} from 'plotly-icons';
import ReactDOM from 'react-dom/client';
import './index.css';

/**
 * Strings of the form `gristsrc:${colRef}` represent Grist table columns.
 * The colRef is the numeric row ID of the metadata record.
 * It's used instead of `colId` because it's stable across renames.
 * The strings appear in 3 places as described in the README:
 * 1. As the values of various `${attr}src` properties in the `data` array produced by Plotly.
 *    The `gristsrc:` prefix makes it easy to identify these values, which is essential.
 *    (although I don't know if other values could actually end up there)
 * 2. As the `value` properties of the `dataSourceOptions` array.
 * 3. As the keys of the `dataSources` object.
 */
const srcPrefix = "gristsrc:"

function colRefToSrc(colRef) {
  return srcPrefix + colRef;
}

function isGristSrc(src) {
  return typeof src === "string" && src.startsWith(srcPrefix);
}

/**
 * Recursively walk through `dataTarget` looking for `gristsrc:` strings.
 * For each one, look up the string in `dataSources` to get the array of column values.
 * Push an object to `columns` containing the array of `values`, a function `setterInDataTarget`
 * to set new `values` back into `dataTarget`, and other possible useful context.
 *
 * `dataTarget` is a proxy produced by immer, so you can write mutation-style code.
 * The underlying value may be an array or an object.
 * Initially this function is called with `dataTarget` being a trace object,
 * i.e. an element of the plotly `data` array.
 * Then it may be recursively called with values within `dataTarget`.
 */
function fillInData(dataTarget, dataSources, columns) {
  for (const srcKey in dataTarget) {
    const val = dataTarget[srcKey];
    if (srcKey === "0" && typeof val !== "object") {
      // This is an optimisation to avoid long loops through arrays of column values.
      // We can't check if `dataTarget` is an array because it's a proxy produced by immer.
      return;
    }
    if (srcKey.endsWith("src") && val) {
      // We might have a single string or an array of strings.
      const sources = typeof val === "string" ? [val] : val;
      if (!Array.isArray(sources) || !sources.length || !isGristSrc(sources[0])) {
        continue;
      }
      // Replace the source(s) with a new array of sources that are actually present,
      // i.e. this is where columns being deleted from the Grist table is handled.
      // Also collect the corresponding arrays of column values.
      const newSources = [];
      let values = [];
      for (const source of sources) {
        if (source in dataSources) {
          newSources.push(source);
          values.push([...dataSources[source]]);
        }
      }
      dataTarget[srcKey] = newSources.length === 1 ? newSources[0] : newSources;

      // e.g. `srcKey` is "xsrc", `valuesKey` is "x"
      const valuesKey = srcKey.slice(0, -3);
      if (values.length === 1) {
        function setterInDataTarget(v) {
          dataTarget[valuesKey] = v;
        }

        values = values[0];
        columns.push({ values, setterInDataTarget });
      } else {
        values.forEach((column, i) => {
          function setterInDataTarget(v) {
            dataTarget[valuesKey][i] = v;
          }

          columns.push({ values: column, setterInDataTarget });
        });
      }
    } else if (typeof val === "object") {
      fillInData(dataTarget[srcKey], dataSources, columns);
    }
  }
}

/**
 * Return a copy of the `data` array with arrays of column values filled in
 * using values derived from `dataSources`.
 * See the README and `fillInData` for details.
 */
function produceFilledInData(data, dataSources) {
  if (!data) {
    return [];
  }
  // In React, state isn't *supposed* to be mutated directly.
  // immer's produce function makes it easy to produce a copy without mutation.
  // But this might not actually matter because react-chart-editor *does* mutate the state:
  // https://github.com/plotly/react-chart-editor/issues/356
  // Still, this seems safer.
  return produce(data, draft => {
    for (const trace of draft) {
      const columns = [];
      fillInData(trace, dataSources, columns);

      // This is where other kinds of data transformations could be added.
      // (see https://github.com/gristlabs/custom-charts-widget/issues/2)
      // These transformations should leave an appropriate `values` array in each column.
      // They can either modify the `values` array in place, or replace it with a new array.
      flattenLists(columns);

      for (const { values, setterInDataTarget } of columns) {
        setterInDataTarget(values);
        // i.e. set either `dataTarget[valuesKey]` or `dataTarget[valuesKey][i]` to `values`
        // where `dataTarget` is either `trace` itself or a nested object within it.
      }
    }
  });
}

// This is needed to avoid errors from immer when react-chart-editor mutates the state.
setAutoFreeze(false);

function flattenLists(columns) {
  for (const col of columns) {
    if (!col.values.some(Array.isArray)) {
      continue;
    }
    for (const col of columns) {
      col.newValues = [];
    }
    for (let valueIndex = 0; valueIndex < col.values.length; valueIndex++) {
      const value = col.values[valueIndex];
      const valueArr = Array.isArray(value) ? value : [value];
      col.newValues.push(...valueArr);
      for (const otherCol of columns) {
        if (otherCol === col) {
          continue;
        }
        otherCol.newValues.push(...new Array(valueArr.length).fill(otherCol.values[valueIndex]));
      }
    }
    for (const col of columns) {
      col.values = col.newValues;
    }
  }
}

// Whether a column is internal and should be hidden.
export function isHiddenCol(colId) {
  return colId.startsWith('gristHelper_') || colId === 'manualSort';
}

/* ==========================================================================
 * CUSTOMISATION « choropleth atlas map » :
 * affiche les données DANS chaque pays, en plus de la couleur.
 *
 * Pour chaque trace Plotly de type `choropleth` :
 *   1. on renseigne `text` (valeur affichée) et un `hovertemplate` détaillé,
 *   2. on ajoute une (ou deux) trace(s) `scattergeo` en mode `text` qui
 *      dessinent la valeur au centroïde de chaque pays, avec une couleur de
 *      texte (foncé/blanc) choisie automatiquement selon la luminosité de la
 *      couleur du pays (évaluée via le colorscale de la trace).
 *
 * Les traces ajoutées portent un nom commençant par LABEL_PREFIX ; elles sont
 * retirées avant sauvegarde de la configuration dans les options Grist, donc
 * elles sont toujours recalculées à partir des vraies données.
 * ========================================================================== */

const LABEL_PREFIX = 'Étiquettes pays'; // préfixe des noms des traces ajoutées
const SHOW_COUNTRY_LABELS = true;       // passer à false pour ne garder que le survol

// Échelles de couleurs nommées de Plotly (copiées depuis
// plotly.js src/components/colorscale/scales.js) pour évaluer la couleur d'un pays.
const PLOTLY_NAMED_SCALES = {"Greys":[[0,"rgb(0,0,0)"],[1,"rgb(255,255,255)"]],"YlGnBu":[[0,"rgb(8,29,88)"],[0.125,"rgb(37,52,148)"],[0.25,"rgb(34,94,168)"],[0.375,"rgb(29,145,192)"],[0.5,"rgb(65,182,196)"],[0.625,"rgb(127,205,187)"],[0.75,"rgb(199,233,180)"],[0.875,"rgb(237,248,217)"],[1,"rgb(255,255,217)"]],"Greens":[[0,"rgb(0,68,27)"],[0.125,"rgb(0,109,44)"],[0.25,"rgb(35,139,69)"],[0.375,"rgb(65,171,93)"],[0.5,"rgb(116,196,118)"],[0.625,"rgb(161,217,155)"],[0.75,"rgb(199,233,192)"],[0.875,"rgb(229,245,224)"],[1,"rgb(247,252,245)"]],"YlOrRd":[[0,"rgb(128,0,38)"],[0.125,"rgb(189,0,38)"],[0.25,"rgb(227,26,28)"],[0.375,"rgb(252,78,42)"],[0.5,"rgb(253,141,60)"],[0.625,"rgb(254,178,76)"],[0.75,"rgb(254,217,118)"],[0.875,"rgb(255,237,160)"],[1,"rgb(255,255,204)"]],"Bluered":[[0,"rgb(0,0,255)"],[1,"rgb(255,0,0)"]],"RdBu":[[0,"rgb(5,10,172)"],[0.35,"rgb(106,137,247)"],[0.5,"rgb(190,190,190)"],[0.6,"rgb(220,170,132)"],[0.7,"rgb(230,145,90)"],[1,"rgb(178,10,28)"]],"Reds":[[0,"rgb(220,220,220)"],[0.2,"rgb(245,195,157)"],[0.4,"rgb(245,160,105)"],[1,"rgb(178,10,28)"]],"Blues":[[0,"rgb(5,10,172)"],[0.35,"rgb(40,60,190)"],[0.5,"rgb(70,100,245)"],[0.6,"rgb(90,120,245)"],[0.7,"rgb(106,137,247)"],[1,"rgb(220,220,220)"]],"Picnic":[[0,"rgb(0,0,255)"],[0.1,"rgb(51,153,255)"],[0.2,"rgb(102,204,255)"],[0.3,"rgb(153,204,255)"],[0.4,"rgb(204,204,255)"],[0.5,"rgb(255,255,255)"],[0.6,"rgb(255,204,255)"],[0.7,"rgb(255,153,255)"],[0.8,"rgb(255,102,204)"],[0.9,"rgb(255,102,102)"],[1,"rgb(255,0,0)"]],"Rainbow":[[0,"rgb(150,0,90)"],[0.125,"rgb(0,0,200)"],[0.25,"rgb(0,25,255)"],[0.375,"rgb(0,152,255)"],[0.5,"rgb(44,255,150)"],[0.625,"rgb(151,255,0)"],[0.75,"rgb(255,234,0)"],[0.875,"rgb(255,111,0)"],[1,"rgb(255,0,0)"]],"Portland":[[0,"rgb(12,51,131)"],[0.25,"rgb(10,136,186)"],[0.5,"rgb(242,211,56)"],[0.75,"rgb(242,143,56)"],[1,"rgb(217,30,30)"]],"Jet":[[0,"rgb(0,0,131)"],[0.125,"rgb(0,60,170)"],[0.375,"rgb(5,255,255)"],[0.625,"rgb(255,255,0)"],[0.875,"rgb(250,0,0)"],[1,"rgb(128,0,0)"]],"Hot":[[0,"rgb(0,0,0)"],[0.3,"rgb(230,0,0)"],[0.6,"rgb(255,210,0)"],[1,"rgb(255,255,255)"]],"Blackbody":[[0,"rgb(0,0,0)"],[0.2,"rgb(230,0,0)"],[0.4,"rgb(230,210,0)"],[0.7,"rgb(255,255,255)"],[1,"rgb(160,200,255)"]],"Earth":[[0,"rgb(0,0,130)"],[0.1,"rgb(0,180,180)"],[0.2,"rgb(40,210,40)"],[0.4,"rgb(230,230,50)"],[0.6,"rgb(120,70,20)"],[1,"rgb(255,255,255)"]],"Electric":[[0,"rgb(0,0,0)"],[0.15,"rgb(30,0,100)"],[0.4,"rgb(120,0,100)"],[0.6,"rgb(160,90,0)"],[0.8,"rgb(230,200,0)"],[1,"rgb(255,250,220)"]],"Viridis":[[0,"#440154"],[0.06274509803921569,"#48186a"],[0.12549019607843137,"#472d7b"],[0.18823529411764706,"#424086"],[0.25098039215686274,"#3b528b"],[0.3137254901960784,"#33638d"],[0.3764705882352941,"#2c728e"],[0.4392156862745098,"#26828e"],[0.5019607843137255,"#21918c"],[0.5647058823529412,"#1fa088"],[0.6274509803921569,"#28ae80"],[0.6901960784313725,"#3fbc73"],[0.7529411764705882,"#5ec962"],[0.8156862745098039,"#84d44b"],[0.8784313725490196,"#addc30"],[0.9411764705882353,"#d8e219"],[1,"#fde725"]],"Cividis":[[0,"rgb(0,32,76)"],[0.058824,"rgb(0,42,102)"],[0.117647,"rgb(0,52,110)"],[0.176471,"rgb(39,63,108)"],[0.235294,"rgb(60,74,107)"],[0.294118,"rgb(76,85,107)"],[0.352941,"rgb(91,95,109)"],[0.411765,"rgb(104,106,112)"],[0.470588,"rgb(117,117,117)"],[0.529412,"rgb(131,129,120)"],[0.588235,"rgb(146,140,120)"],[0.647059,"rgb(161,152,118)"],[0.705882,"rgb(176,165,114)"],[0.764706,"rgb(192,177,109)"],[0.823529,"rgb(209,191,102)"],[0.882353,"rgb(225,204,92)"],[0.941176,"rgb(243,219,79)"],[1,"rgb(255,233,69)"]]};

// Convertit n'importe quelle couleur CSS en [r, g, b] grâce à un canvas.
const _colorCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
function cssToRgb(color) {
  if (!color || !_colorCtx) return null;
  _colorCtx.fillStyle = '#000';
  _colorCtx.fillStyle = color;
  const v = _colorCtx.fillStyle; // normalisé en "#rrggbb" ou "rgb(r, g, b)"
  const m = String(v).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  if (v[0] === '#') {
    const h = v.slice(1);
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  return null;
}

// Évalue un colorscale Plotly (nom ou tableau [[t, couleur], ...]) à t ∈ [0, 1].
function evalColorScale(colorscale, t) {
  let scale = colorscale;
  if (typeof scale === 'string') scale = PLOTLY_NAMED_SCALES[scale] || PLOTLY_NAMED_SCALES['Viridis'];
  if (!scale) scale = PLOTLY_NAMED_SCALES['Viridis']; // défaut plotly.js v2
  if (!Array.isArray(scale) || !scale.length) return null;
  t = Math.max(0, Math.min(1, t));
  let lo = scale[0], hi = scale[scale.length - 1];
  for (let i = 0; i < scale.length - 1; i++) {
    if (t >= scale[i][0] && t <= scale[i + 1][0]) { lo = scale[i]; hi = scale[i + 1]; break; }
  }
  const span = (hi[0] - lo[0]) || 1;
  const f = (t - lo[0]) / span;
  const c0 = cssToRgb(lo[1]) || [128, 128, 128];
  const c1 = cssToRgb(hi[1]) || [128, 128, 128];
  return c0.map((c, i) => Math.round(c + (c1[i] - c) * f));
}

// Luminosité perçue ; null (échelle inconnue) → valeur moyenne.
function luminance(rgb) {
  if (!rgb) return 128;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

// Centroïde (approx. lon/lat) du plus grand polygone d'une géométrie GeoJSON.
function centroidOfGeometry(geometry) {
  if (!geometry) return null;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  let best = null, bestLen = -1;
  for (const poly of polys) {
    const ring = poly[0] || [];
    if (ring.length > bestLen) { bestLen = ring.length; best = ring; }
  }
  if (!best || best.length < 3) return null;
  let x = 0, y = 0, twiceArea = 0;
  let prev = best[best.length - 1];
  for (const pt of best) {
    // Correction du passage à l'antiméridien (Russie, Fidji, etc.)
    let dx = pt[0] - prev[0];
    if (dx > 180) dx -= 360; else if (dx < -180) dx += 360;
    const px = prev[0] + dx;
    const cross = px * pt[1] - pt[0] * prev[1];
    twiceArea += cross;
    x += (px + pt[0]) * cross;
    y += (prev[1] + pt[1]) * cross;
    prev = pt;
  }
  if (Math.abs(twiceArea) < 1e-12) return [best[0][0], best[0][1]];
  return [x / (3 * twiceArea), y / (3 * twiceArea)];
}

// Charge une seule fois : centroïdes des pays (GeoJSON 110m, id = ISO-3)
// + table de correspondance ISO-2 → ISO-3.
let _centroidsPromise = null;
function loadCountryCentroids() {
  if (!_centroidsPromise) {
    _centroidsPromise = Promise.all([
      fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json').then(r => r.json()),
      fetch('https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json').then(r => r.json()),
    ]).then(([geo, isoList]) => {
      const byIso3 = {}, byName = {};
      for (const f of geo.features || []) {
        const c = centroidOfGeometry(f.geometry);
        if (!c) continue;
        if (f.id) byIso3[String(f.id).toUpperCase()] = c;
        const name = f.properties && f.properties.name;
        if (name) byName[String(name).toLowerCase()] = c;
      }
      const iso2to3 = {};
      for (const c of isoList || []) {
        if (c['alpha-2'] && c['alpha-3']) iso2to3[c['alpha-2'].toUpperCase()] = c['alpha-3'].toUpperCase();
        if (c.name && c['alpha-3'] && byIso3[c['alpha-3'].toUpperCase()]) {
          byName[String(c.name).toLowerCase()] = byIso3[c['alpha-3'].toUpperCase()];
        }
      }
      return { byIso3, byName, iso2to3 };
    }).catch(err => {
      console.warn('Centroïdes des pays indisponibles, seules les infobulles seront affichées.', err);
      return null;
    });
  }
  return _centroidsPromise;
}

function locationToCentroid(loc, locationmode, centroids) {
  if (!centroids || loc == null) return null;
  const key = String(loc);
  if (locationmode === 'ISO-2') {
    const iso3 = centroids.iso2to3[key.toUpperCase()];
    return iso3 ? centroids.byIso3[iso3] : null;
  }
  if (locationmode === 'country names') {
    return centroids.byName[key.toLowerCase()] || null;
  }
  // 'ISO-3' (défaut) avec repli sur le nom du pays
  return centroids.byIso3[key.toUpperCase()] || centroids.byName[key.toLowerCase()] || null;
}

/**
 * Transforme le tableau de traces pour une carte choroplèthe « atlas » :
 * - chaque trace choropleth reçoit `text` + `hovertemplate` (données au survol) ;
 * - une ou deux traces scattergeo ajoutent la valeur au centroïde de chaque pays
 *   (texte foncé sur fond clair, blanc sur fond foncé).
 * Retourne toujours un NOUVEAU tableau (le state React n'est pas muté).
 */
function addCountryLabels(data, centroids) {
  if (!Array.isArray(data)) return data;
  const out = [];
  for (const trace of data) {
    if (!trace || trace.type !== 'choropleth') { out.push(trace); continue; }
    const t = { ...trace };
    // Valeur affichée dans le pays : colonne `text` mappée si présente, sinon `z`.
    if (!t.text && Array.isArray(t.z)) {
      t.text = t.z.map(v => (v == null ? '' : String(v)));
    }
    if (!t.hovertemplate) {
      t.hovertemplate = t.text
        ? '<b>%{location}</b><br>%{text}<br>Valeur (z) : %{z}<extra></extra>'
        : '<b>%{location}</b><br>Valeur (z) : %{z}<extra></extra>';
    }
    out.push(t);
  }
  if (!SHOW_COUNTRY_LABELS || !centroids) return out;
  for (const trace of out) {
    if (!trace || trace.type !== 'choropleth') continue;
    const locations = trace.locations;
    if (!Array.isArray(locations) || !locations.length) continue;
    const mode = trace.locationmode || 'ISO-3';
    const z = Array.isArray(trace.z) ? trace.z : [];
    const labels = Array.isArray(trace.text) ? trace.text : z;
    const nums = z.filter(v => typeof v === 'number');
    const zmin = trace.zmin != null ? trace.zmin : (nums.length ? Math.min(...nums) : 0);
    const zmax = trace.zmax != null ? trace.zmax : (nums.length ? Math.max(...nums) : 1);
    const groups = {
      dark: { lon: [], lat: [], text: [] },   // texte foncé (fond clair)
      light: { lon: [], lat: [], text: [] },  // texte blanc (fond foncé)
    };
    for (let i = 0; i < locations.length; i++) {
      const c = locationToCentroid(locations[i], mode, centroids);
      if (!c) continue;
      const zi = z[i];
      const zn = typeof zi === 'number' && zmax > zmin ? (zi - zmin) / (zmax - zmin) : 0.5;
      const darkText = luminance(evalColorScale(trace.colorscale, zn)) > 150;
      const g = darkText ? groups.dark : groups.light;
      g.lon.push(c[0]);
      g.lat.push(c[1]);
      const v = labels[i];
      g.text.push(v == null || v === '' ? (zi == null ? '' : String(zi)) : String(v));
    }
    for (const [key, g] of Object.entries(groups)) {
      if (!g.lon.length) continue;
      out.push({
        type: 'scattergeo',
        mode: 'text',
        lon: g.lon,
        lat: g.lat,
        text: g.text,
        textfont: { size: 11, color: key === 'dark' ? '#1a1a1a' : '#ffffff' },
        textposition: 'middle center',
        hoverinfo: 'skip',
        showlegend: false,
        name: LABEL_PREFIX + (key === 'dark' ? ' (fond clair)' : ' (fond foncé)'),
        geo: trace.geo,
      });
    }
  }
  return out;
}

// Indique si une trace est une étiquette ajoutée automatiquement.
function isLabelTrace(t) {
  return !!(t && typeof t.name === 'string' && t.name.startsWith(LABEL_PREFIX));
}
/* ===================== FIN DE LA CUSTOMISATION ===================== */

const { grist } = window;

async function getColumns() {
  // It'd be nice if most of this logic was handled by the plugin API.
  // Avoiding the server requests from fetchTable might be a noticeable speedup.
  const tableId = await grist.selectedTable.getTableId();
  const tables = await grist.docApi.fetchTable('_grist_Tables');
  const columns = await grist.docApi.fetchTable('_grist_Tables_column');
  const tableRef = tables.id[tables.tableId.indexOf(tableId)];
  const columnRecords = columns.id.map((_id, i) =>
    Object.fromEntries(Object.keys(columns).map(key => [key, columns[key][i]]))
  );
  return columnRecords.filter(
    col => col.parentId === tableRef
      && !isHiddenCol(col.colId)
      && col.type !== "Attachments"
  );
}

class App extends Component {
  constructor(props) {
    super(props);
    this.state = {
      data: [],
      layout: {
        margin: {
          l: 50,
          r: 50,
          b: 40,  // Space below chart which includes x-axis labels
          t: 30,  // Space above the chart (doesn't include any text)
          pad: 4
        },
      },
      frames: [],
      dataSources: {},
      dataSourceOptions: [],
      hideControls: true,
      centroids: null,  // CUSTOMISATION : centroïdes des pays (chargés une fois)
    };
    // CUSTOMISATION : charger les centroïdes des pays pour les étiquettes.
    loadCountryCentroids().then(centroids => this.setState({ centroids }));

    const onGristUpdate = async (tableData) => {
      const columns = await getColumns();
      const colIdToSrc = Object.fromEntries(columns.map(col => [col.colId, colRefToSrc(col.id)]));
      const dataSources = Object.fromEntries(Object.entries(tableData).map(
        ([colId, values]) => [colIdToSrc[colId], values.map(v => v === '' || v == null ? '[Blank]' : v)]
      ));
      const dataSourceOptions = columns.map(col => ({
        value: colRefToSrc(col.id),
        label: col.label
      })).filter(col => col.value in dataSources);

      const state = await grist.getOption('state');
      const data = produceFilledInData(state?.data, dataSources);
      this.setState({ ...state, data, dataSources, dataSourceOptions });
      if (!data.length) {
        this.setState({ hideControls: false });
      }
    };
    const dataOptions = {format: 'columns', includeColumns: 'normal'};
    try {
      grist.onRecords(onGristUpdate, dataOptions);
    } catch (e) {
      // Happens if we don't have full access.
      console.warn(e);
    }
    grist.onOptions(async () => {
      const tableData = await grist.fetchSelectedTable(dataOptions);
      await onGristUpdate(tableData);
    });
    grist.ready({
      requiredAccess: 'full',
      onEditOptions: () => this.setHideControls(!this.state.hideControls),
    });
  }

  setHideControls(hideControls) {
    this.setState((state) => {
      if (!state.data.length) {
        return;
      }
      return {
        hideControls,
        // Make a copy of data to tell plotly to refresh so that it resizes
        data: [...state.data],
      };
    });
    // Refresh again shortly after, the first time sometimes isn't quite right.
    setTimeout(() => {
      this.setState(state => ({
        data: [...state.data],
      }))
    }, 20);
  }

  render() {
    // CUSTOMISATION : on n'ajoute les étiquettes de pays qu'à l'affichage,
    // jamais dans le state sauvegardé (mémoïsé pour éviter les re-rendus Plotly).
    if (this._memoData !== this.state.data || this._memoCentroids !== this.state.centroids) {
      this._memoData = this.state.data;
      this._memoCentroids = this.state.centroids;
      this._memoDisplayData = addCountryLabels(this.state.data, this.state.centroids);
    }
    return (<div className="app">
      <PlotlyEditor
        hideControls={this.state.hideControls}
        data={this._memoDisplayData}
        layout={this.state.layout}
        config={{
          displayModeBar: "hover",
          displaylogo: false,
          modeBarButtonsToAdd: [
            {
              name: "Download plot as a png",
              icon: plotly.Icons.camera,
              click: function (graphDiv) {
                plotly.downloadImage(graphDiv, {
                  format: "png",
                  filename: "newplot",
                });
              },
            },
            {
              name: "Download plot as an svg",
              icon: plotly.Icons.disk,
              click: function (graphDiv) {
                plotly.downloadImage(graphDiv, {
                  format: "svg",
                  filename: "newplot",
                });
              },
            },
          ],
          modeBarButtonsToRemove: ["toImage"],
        }}
        frames={this.state.frames}
        dataSources={this.state.dataSources}
        dataSourceOptions={this.state.dataSourceOptions}
        plotly={plotly}
        onUpdate={(data, layout, frames) => {
          // console.log("onUpdate", { data, layout, frames });

          // CUSTOMISATION : retirer les étiquettes de pays avant sauvegarde,
          // elles sont recalculées automatiquement à partir des données Grist.
          data = (data || []).filter(t => !isLabelTrace(t));

          // Set automargin on all axes by default, but users can override this.
          for (const [key, value] of Object.entries(layout)) {
            if (/^[xyz]axis\d*$/.test(key) && !("automargin" in value)) {
              value.automargin = true;
              // Ensure the plotly notices the change in state.
              layout = { ...layout };
            }
          }

          // Save the configuration minus the data as a widget option.
          const emptyDataSources = Object.fromEntries(this.state.dataSourceOptions.map(({ value }) => [value, []]));
          data = produceFilledInData(data, emptyDataSources);
          // This triggers grist.onOptions above, ultimately calling produceFilledInData with the real data.
          grist.setOption('state', { data, layout, frames });
        }}
        useResizeHandler
        advancedTraceTypeSelector
      />
      {
        // Always show the controls when there are no traces yet.
        this.state.data.length > 0 && (
        !this.state.hideControls ?
          <div className="editor_controls plotly-editor--theme-provider">
            <Button
              className="controls-button"
              variant="primary"
              onClick={() => this.setHideControls(true)}
              style={{
                height: 'auto',
                width: 'calc(var(--sidebar-width) - 10px)',
              }}
            >
              Hide Controls
            </Button>
          </div>
          :
          <CogIcon
            className="controls-button show-controls-icon-button"
            onClick={() => this.setHideControls(false)}
          />
      )
      }
    </div>);
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <App/>
);
