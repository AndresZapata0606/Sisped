let baseUrl = window.location.origin;

// Detect API server on alternative port (dev convenience)
(async function detectApiFallback() {
  try {
    // quick check against current origin
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/products`, { method: 'GET' });
    if (resp.ok) return;
  } catch (e) {
    // ignore
  }

  // Probar varios puertos de desarrollo comunes (orden preferente)
  const alts = [
    'http://127.0.0.1:55681',
    'http://127.0.0.1:55042'
  ];

  for (const altUrl of alts) {
    try {
      const r = await fetch(`${altUrl.replace(/\/$/, '')}/api/products`, { method: 'GET' });
      if (r.ok) {
        console.log('API fallback: using', altUrl);
        baseUrl = altUrl;
        break;
      }
    } catch (e) {
      // intentar siguiente
    }
  }
})();
const pendingItems = [];
let productsViewFilter = 'all';
let productsViewCategory = 'all';
let routeMapInstance = null;
let routeLayerGroup = null;
let googleMapInstance = null;
let googleMarkers = [];
let googleDebugMarkers = [];
let googleDebugOverlays = [];
let googlePolyline = null;
let drawnItems = null; // Para Leaflet.draw

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

// --- CONFIGURACIÓN LOGÍSTICA AVANZADA ---
let LOGISTICS_CONFIG = {
  maxRouteDistanceKm: 12,
  maxOrdersPerBatch: 6,
  deliveryBufferMin: 10,
  averageSpeedKmH: 25,
  dangerousZones: [] // Se cargará desde el API
};

/**
 * Verifica si un punto (lat, lon) está dentro de alguna zona peligrosa.
 * @param {Array<number>} point [latitude, longitude]
 * @returns {boolean}
 */
function isPointInDangerousZone(point) {
  return LOGISTICS_CONFIG.dangerousZones.some(zone => {
    return turf.booleanPointInPolygon(turf.point([point[1], point[0]]), turf.polygon([zone.polygon]));
  });
}

/**
 * Analiza la carga de pedidos de los domiciliarios activos y sugiere balanceo
 */
function checkDriverBalance(drivers, orders) {
  const activeDrivers = drivers.filter(d => Number(d.active) === 1);
  // Solo balancear si hay al menos 2 conductores operativos
  if (activeDrivers.length < 2) return;

  const driverStats = activeDrivers.map(d => {
    const assignedOrders = orders.filter(o => 
      Number(o.driver_id) === Number(d.id) && 
      !['entregado', 'cancelado'].includes(String(o.status).toLowerCase())
    );
    return { name: d.name, count: assignedOrders.length };
  });

  // Ordenar de más a menos ocupado
  const sorted = [...driverStats].sort((a, b) => b.count - a.count);
  const busiest = sorted[0];
  const loneliest = sorted[sorted.length - 1];

  // Umbral: diferencia de 4 pedidos y el más ocupado tiene al menos 6
  if (busiest.count - loneliest.count >= 4 && busiest.count >= 6) {
    showToast(`⚖️ Balanceo: ${busiest.name} tiene ${busiest.count} pedidos, mientras que ${loneliest.name} solo tiene ${loneliest.count}. Considera redistribuir.`, 'info');
  }
}

/**
 * Calcula el PriorityScore de un pedido (0 a 100)
 */
function calculatePriorityScore(order) {
  let score = 0;
  const createdAt = parseBogotaDate(order.created_at);
  const minutesWaiting = createdAt ? (Date.now() - createdAt.getTime()) / 60000 : 0;
  
  // Factor Tiempo: +1 punto por cada minuto de espera (max 40)
  score += Math.min(minutesWaiting, 40);
  
  // Factor Valor: +10 puntos si es un pedido de más de $80k
  if (order.total > 80000) score += 15;
  
  // Factor Urgencia Manual:
  if (order.urgency_level === 'critical') score += 40;
  if (order.urgency_level === 'high') score += 20;

  // Si está en zona peligrosa, subir prioridad para despacho rápido
  if (isPointInDangerousZone([order.latitude, order.longitude])) score += 15;

  return Math.min(score, 100);
}

const dashboardState = {
  products: [],
  drivers: [],
  orders: [],
  clients: [],
  routeSuggestion: null,
  selectedSuggestedRouteIndex: 0,
  routeOptimization: null,
  stats: null
}; 
let deliveryRoutesHistory = []; // Nuevo estado para el historial de rutas de domicilios
let dailyClosuresHistory = [];

// State for orders table pagination
const ordersTableState = {
  page: 1,
  pageSize: 8,
  filter: 'all',
  searchTerm: ''
};
const clientsTableState = {
  page: 1,
  pageSize: 10,
  searchTerm: '',
  selectedId: null
};
const driversTableState = {
  searchTerm: ''
};
const productsTableState = {
  searchTerm: ''
};
// currently selected order id in the table
ordersTableState.selectedId = null;

const caliCommuneCenters = {
  1: [3.4645, -76.5450],
  2: [3.4740, -76.5180],
  3: [3.4575, -76.5305],
  4: [3.4485, -76.5225],
  5: [3.4375, -76.5285],
  6: [3.4300, -76.5320],
  7: [3.4435, -76.5095],
  8: [3.4295, -76.5045],
  9: [3.4215, -76.4995],
  10: [3.4145, -76.4920],
  11: [3.4045, -76.4925],
  12: [3.3980, -76.5045],
  13: [3.3920, -76.5215],
  14: [3.3835, -76.5195],
  15: [3.3910, -76.5345],
  16: [3.4098, -76.5048],
  17: [3.4220, -76.5200],
  18: [3.4055, -76.5480],
  19: [3.3945, -76.5450],
  20: [3.3855, -76.5420],
  21: [3.3735, -76.5350],
  22: [3.4520, -76.5550]
};

let caliNeighborhoodCenters = {
  // NORTE
  'prados del norte': [3.4868, -76.5178],
  floralia: [3.485, -76.495],
  vipasa: [3.4765, -76.515],
  'la flora': [3.4847, -76.5149],
  chipichape: [3.4742, -76.5169],
  sameco: [3.5012, -76.5078],
  salomia: [3.4701, -76.5075],
  'la campina': [3.4727, -76.5284],
  'san vicente': [3.4646, -76.5274],
  'santa monica': [3.4668, -76.5353],
  'la merced': [3.467, -76.5235],
  'juanambu': [3.4546, -76.5389],
  'el penon': [3.4617, -76.545],
  'los alamos': [3.4723, -76.5078],
  'villa del prado': [3.479, -76.4908],
  chiminangos: [3.468, -76.4945],
  calima: [3.4732, -76.5019],
  menga: [3.4905, -76.4988],
  'el bosque': [3.4748, -76.514],

  // CENTRO
  centro: [3.4516, -76.5320],
  granada: [3.4512, -76.5331],
  versalles: [3.4604, -76.5291],
  'san nicolas': [3.4572, -76.5272],
  'san antonio': [3.4475, -76.5395],
  'san pascual': [3.4443, -76.5347],
  'barrio obrero': [3.4518, -76.5188],
  guayaquil: [3.45, -76.527],
  alameda: [3.4429, -76.529],
  'santa isabel': [3.439, -76.5452],
  'santa teresita': [3.455, -76.54],

  // SUR
  tequendama: [3.4297, -76.5402],
  'san fernando': [3.4392, -76.5486],
  belen: [3.4024, -76.5426],
  'el caney': [3.385, -76.525],
  'antonio nariño': [3.4098, -76.5048],
  'los cambulos': [3.4206, -76.54185],
  'panamericano': [3.4229, -76.5358],
  'siloe': [3.4299, -76.5523],
  miraflores: [3.4338, -76.541],
  'el lido': [3.4316, -76.548],
  'nuevo tequendama': [3.418, -76.544],
  'santa anita': [3.3774, -76.5442],
  asturias: [3.397, -76.533],
  ingenio: [3.389, -76.54],
  'valle del lili': [3.375, -76.53],
  capri: [3.4095, -76.5455],
  pampalinda: [3.4242, -76.5454],
  'ciudad jardin': [3.3738, -76.5382],
  bochalema: [3.358, -76.536],
  pance: [3.34, -76.54],

  // ORIENTE
  'union de vivienda popular': [3.4152, -76.5135],
  'mariano ramos': [3.408, -76.505],
  'alfonso lopez': [3.4525, -76.5012],
  'republica de israel': [3.411568, -76.515763],
  mojica: [3.4214, -76.4849],
  'los lagos': [3.4171, -76.4958],
  'comuna 16': [3.4098, -76.5048],
  'potrero grande': [3.3992, -76.4755],
  'ciudad cordoba': [3.4278, -76.4888],
  villacolombia: [3.46, -76.5005],
  'la base': [3.454, -76.504],
  'el troncal': [3.457, -76.4988],
  'san carlos': [3.4395, -76.5072],
  'marroquin': [3.427, -76.49],

  // OESTE
  normandia: [3.4565, -76.5512],
  'santa rita': [3.4582, -76.5481],
  arboledas: [3.4527, -76.5468],
  bellavista: [3.4378, -76.5562],
  cristales: [3.444, -76.565],
  aguacatal: [3.468, -76.575],
  'san cayetano': [3.4555, -76.56]
};

function hashString(value) {
  return String(value || '').split('').reduce((accumulator, character) => ((accumulator << 5) - accumulator) + character.charCodeAt(0), 0);
}

function normalizeNeighborhood(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function dedupeOrdersById(orders) {
  const seen = new Set();
  return Array.isArray(orders)
    ? orders.filter((order) => {
        const key = order && order.id != null ? String(order.id) : null;
        if (!key) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    : [];
}

function getRouteCoordinate(order, index = 0) {
  // Si el pedido tiene coordenadas precisas y válidas, úsalas
  if (order && order.latitude != null && order.longitude != null) {
    const lat = Number(order.latitude);
    const lon = Number(order.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 0.0001 && Math.abs(lon) > 0.0001) {
      return [lat, lon];
    }
  }

  const nBarrio = normalizeNeighborhood(order.barrio);
  const nZone = normalizeNeighborhood(order.route_zone);
  const nAddress = normalizeNeighborhood(order.address);
  const communeMatch = nBarrio.match(/comuna\s*(\d{1,2})/);
  const communeCenter = communeMatch ? caliCommuneCenters[Number(communeMatch[1])] : null;

  // Búsqueda inteligente: intentamos encontrar el match más cercano
  const bestKey = Object.keys(caliNeighborhoodCenters).find(key => {
    const nKey = normalizeNeighborhood(key);
    // Match si el input está contenido en la llave o viceversa (ej: "lili" matches "valle del lili")
    return (nBarrio && (nKey.includes(nBarrio) || nBarrio.includes(nKey))) ||
           (nZone && (nKey.includes(nZone) || nZone.includes(nKey))) ||
           (nAddress && nAddress.includes(nKey));
  });

  const base = caliNeighborhoodCenters[bestKey] || communeCenter || [3.411568, -76.515763]; // SISPED SW coordinates
  const offsetSeed = hashString(`${order.address || ''}-${order.id}-${index}`);
  const latOffset = ((offsetSeed % 7) - 3) * 0.0012;
  const lngOffset = (((offsetSeed >> 3) % 7) - 3) * 0.0012;

  return [base[0] + latOffset, base[1] + lngOffset];
}

async function loadGeneratedCaliNeighborhoodCenters() {
  try {
    const response = await fetch('assets/cali-neighborhood-centers.generated.json', { cache: 'no-store' });
    if (!response.ok) return;
    const generatedCenters = await response.json();
    if (generatedCenters && typeof generatedCenters === 'object' && !Array.isArray(generatedCenters)) {
      caliNeighborhoodCenters = { ...caliNeighborhoodCenters, ...generatedCenters };
    }
  } catch (error) {
    console.warn('No se pudo cargar la base completa de barrios de Cali, se usa el fallback local.', error);
  }
}

function formatRouteTitle(value) {
  if (value === 'all') return 'Todos los pedidos listos';
  if (value === 'available') return 'Pedidos listos para despacho';
  return 'Rutas activas';
}

function wireSidebarNavigation() {
  const navItems = Array.from(document.querySelectorAll('[data-target]'));
  const sidebarToggle = document.getElementById('sidebarToggle');
  const newOrderButton = document.getElementById('sidebarNewOrderBtn');

  function setActiveView(viewName) {
    document.querySelectorAll('[data-view]').forEach((panel) => {
      panel.classList.toggle('active-view', panel.dataset.view === viewName);
    });

    navItems.forEach((nav) => nav.classList.toggle('active', nav.dataset.target === viewName));

    const selectedPanel = document.querySelector(`[data-view="${viewName}"]`);
    if (selectedPanel) {
      selectedPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Re-render the active section so the data list is never stale.
    if (viewName === 'clients') {
      try {
        renderClients();
      } catch (err) {
        console.error('Error rendering clients view', err);
      }
    }

    // If switching to orders view, re-render orders table
    if (viewName === 'orders') {
      try {
        renderOrders(dashboardState.orders || []);
      } catch (err) {
        console.error('Error rendering orders view', err);
      }
      document.body.classList.toggle('sidebar-open');
    }

    if (viewName === 'route-history') {
      try {
        renderDeliveryRoutesHistory();
      } catch (err) {
        console.error('Error rendering route history view', err);
      }
    }
  }

  if (newOrderButton) {
    newOrderButton.addEventListener('click', () => {
      openOrderModal();
      if (window.innerWidth <= 840) {
        document.body.classList.remove('sidebar-open');
      }
    });
  }

  // Attach click handlers to navigation items so views can change
  navItems.forEach((nav) => {
    nav.addEventListener('click', (e) => {
      e.preventDefault();
      const target = nav.dataset.target;
      if (target) {
        setActiveView(target);
        if (window.innerWidth <= 840) {
          document.body.classList.remove('sidebar-open');
        }
      }
    });
  });

  // Sidebar toggle (mobile / compact)
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', (e) => {
      e.preventDefault();
      document.body.classList.toggle('sidebar-open');
    });
  }

  setActiveView('overview');
}

// Instancia única reutilizable para mejorar el rendimiento de los cálculos y renderizado
const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0
});

const BOGOTA_TIME_ZONE = 'America/Bogota';

function parseBogotaDate(value) {
  if (value instanceof Date) return value;
  if (value == null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const normalized = raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw;
  const parsed = new Date(`${normalized}-05:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatBogotaDateTime(value) {
  const date = parseBogotaDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatBogotaTime(value) {
  const date = parseBogotaDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatBogotaDate(value) {
  const date = parseBogotaDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function money(value) {
  return copFormatter.format(Number(value || 0));
}

function getBogotaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function scheduleMidnightRefresh() {
  let lastDateKey = getBogotaDateKey();
  setInterval(() => {
    const todayKey = getBogotaDateKey();
    if (todayKey !== lastDateKey) {
      lastDateKey = todayKey;
      window.location.reload();
    }
  }, 60000);
}

async function request(path, options = {}) {
  // Asegurar que la URL esté bien formada sin barras dobles
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${baseUrl.replace(/\/$/, '')}${cleanPath}`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  // Si la respuesta es 204 (No Content), no intentamos procesar JSON
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type');
  const isJson = contentType && contentType.includes('application/json');

  if (!response.ok) {
    const payload = isJson ? await response.json().catch(() => ({})) : {};
    const errorMsg = payload.message || `Error ${response.status}: ${response.statusText}`;
    
    // Log detallado para depuración "de raíz"
    console.group('--- BACKEND ERROR DETAIL ---');
    console.error('Message:', payload.message || errorMsg);
    if (payload.error || payload.stack) console.error('Technical Detail:', payload.stack || payload.error);
    console.groupEnd();

    throw new Error(errorMsg);
  }

  if (!isJson) {
    throw new Error('El servidor no devolvió una respuesta JSON válida.');
  }

  return response.json();
}

// --- Utilidades de Detección de Zonas ---

function attachGeocoding(container) {
  const addressInput = container.querySelector('[name="address"]');
  const barrioInput = container.querySelector('[name="barrio"]');
  if (!addressInput || !barrioInput) return;

  // El barrio ahora es interno para logística, no manual
  const loader = addressInput.closest('.input-with-loader') || addressInput.parentElement;
  const mapEl = container.querySelector('.mini-map-preview');

  // Implementación modernizada (2025) con PlaceAutocompleteElement
  if (window.google && window.google.maps && window.google.maps.places && window.google.maps.places.PlaceAutocompleteElement) {
    const caliBounds = {
      north: 3.50, south: 3.33,
      east: -76.46, west: -76.59
    };

    const autocompleteEl = new google.maps.places.PlaceAutocompleteElement({
      componentRestrictions: { country: 'co' },
      locationBias: caliBounds
    });
    autocompleteEl.style.position = 'relative';
    autocompleteEl.style.zIndex = '10020';
    autocompleteEl.style.display = 'block';

    // Sincronización con el formulario: ocultamos el input original y usamos el nuevo
    // Pero mantenemos el original oculto para que FormData siga funcionando sin cambios.
    addressInput.style.display = 'none';
    addressInput.required = false; // Evita el error "An invalid form control is not focusable"

    addressInput.insertAdjacentElement('afterend', autocompleteEl);
    container.__addressAutocompleteEl = autocompleteEl;
    const addressPanel = addressInput.closest('.panel');

    // Placeholder modernizado
    autocompleteEl.classList.add('modern-autocomplete');

    const openAutocompleteLayer = () => {
      if (addressPanel) addressPanel.classList.add('autocomplete-open');
    };

    const closeAutocompleteLayer = () => {
      if (addressPanel) addressPanel.classList.remove('autocomplete-open');
    };

    const syncTypedAddress = () => {
      const innerInput = autocompleteEl.shadowRoot?.querySelector('input');
      const typedValue = String(innerInput?.value || autocompleteEl.value || '').trim();
      if (typedValue) addressInput.value = typedValue;
      container.dataset.pendingAddress = typedValue;
    };

    // Si ya existen coordenadas (modo edición), mostrar mapa
    const latInp = container.querySelector('[name="latitude"]');
    const lonInp = container.querySelector('[name="longitude"]');

    if (addressInput.value) {
        // Intentar pre-llenar si el componente lo permite (vía atributo interno)
        setTimeout(() => {
            const innerInput = autocompleteEl.shadowRoot?.querySelector('input');
            if (innerInput) innerInput.value = addressInput.value;
        }, 100);
    }

    // Resetear coordenadas al escribir
    autocompleteEl.addEventListener('input', () => {
      openAutocompleteLayer();
      syncTypedAddress();
      barrioInput.value = '';
      const latInp = container.querySelector('[name="latitude"]');
      const lonInp = container.querySelector('[name="longitude"]');
      if (latInp) latInp.value = '';
      if (lonInp) lonInp.value = '';
    });

    autocompleteEl.addEventListener('focus', openAutocompleteLayer);

    const updateMiniMap = (lat, lng) => {
      if (!mapEl) return;
      mapEl.style.display = 'block';
      const pos = { lat: Number(lat), lng: Number(lng) };
      const miniMap = new google.maps.Map(mapEl, {
        center: pos,
        zoom: 17,
        disableDefaultUI: true,
        gestureHandling: 'none',
        mapId: 'DEMO_MAP_ID'
      });
      new google.maps.marker.AdvancedMarkerElement({ position: pos, map: miniMap });
    };

    if (latInp?.value && lonInp?.value) {
      updateMiniMap(latInp.value, lonInp.value);
    }

    autocompleteEl.addEventListener('gmp-placeselect', async (event) => {
      const place = event.place;
      if (!place) return;

      // Cargar campos necesarios (nuevo estándar de fetchFields)
      await place.fetchFields({ fields: ['location', 'addressComponents', 'displayName'] });

      const lat = place.location.lat();
      const lng = place.location.lng();

      // Extraer Barrio (neighborhood o sublocality)
      let barrio = '';
      const components = place.addressComponents;

      const neighborhood = components.find(c => c.types.includes('neighborhood'));
      const sublocality = components.find(c => c.types.includes('sublocality_level_1'));
      barrio = neighborhood ? neighborhood.longName : (sublocality ? sublocality.longName : '');

      // Sincronizar con el input real oculto para el envío del formulario
      addressInput.value = place.formattedAddress || place.displayName || place.name || '';
      container.dataset.pendingAddress = addressInput.value;
      barrioInput.value = barrio || 'Cali'; // Fallback a ciudad si no hay barrio

      if (barrio) showToast(`Ubicación confirmada en ${barrio}`, 'success');

      // Guardar coordenadas ocultas si el formulario lo soporta
      const latInput = container.querySelector('[name="latitude"]');
      const lonInput = container.querySelector('[name="longitude"]');
      if (latInput) latInput.value = lat;
      if (lonInput) lonInput.value = lng;

      // Actualizar visualización del mapa
      updateMiniMap(lat, lng);
      closeAutocompleteLayer();
    });

    autocompleteEl.addEventListener('blur', () => {
      syncTypedAddress();
      setTimeout(closeAutocompleteLayer, 150);
    });

    return; // Salimos, ya no necesitamos el polling manual
  }
}

function syncOrderAddress(container) {
  const addressInput = container.querySelector('[name="address"]');
  if (!addressInput) return '';

  const autocompleteEl = container.__addressAutocompleteEl;
  const innerInput = autocompleteEl?.shadowRoot?.querySelector('input');
  const typedValue = String(innerInput?.value || autocompleteEl?.value || addressInput.value || container.dataset.pendingAddress || '').trim();

  if (typedValue) {
    addressInput.value = typedValue;
    container.dataset.pendingAddress = typedValue;
  }

  return addressInput.value.trim();
}

async function resolveOrderLocation(form) {
  const latInput = form.querySelector('[name="latitude"]');
  const lonInput = form.querySelector('[name="longitude"]');
  const addressInput = form.querySelector('[name="address"]');
  const barrioInput = form.querySelector('[name="barrio"]');

  const address = String(addressInput?.value || '').trim();
  if (!address) return null;

  const lat = Number(latInput?.value);
  const lon = Number(lonInput?.value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
    // Si ya tenemos coordenadas válidas, no necesitamos geocodificar de nuevo.
    return { lat, lon, resolved: false, source: 'cached' }; // No se geocodificó, se usó caché
  }

  const provider = localStorage.getItem('geocodingProvider') || 'auto';
  const tryGoogle = provider === 'auto' || provider === 'google';
  const tryNominatim = provider === 'auto' || provider === 'nominatim';

  // 1. Intentar con Google Geocoding
  if (tryGoogle && window.google && window.google.maps && typeof window.google.maps.Geocoder === 'function') {
    try {
      const geocoder = new window.google.maps.Geocoder();
      const { results } = await geocoder.geocode({ address, componentRestrictions: { country: 'co' } });
      const result = results?.[0];
      const location = result?.geometry?.location;
      if (result && location) {
        const resolvedLat = typeof location.lat === 'function' ? location.lat() : Number(location.lat);
        const resolvedLon = typeof location.lng === 'function' ? location.lng() : Number(location.lng);
        if (Number.isFinite(resolvedLat) && Number.isFinite(resolvedLon)) {
          if (latInput) latInput.value = resolvedLat;
          if (lonInput) lonInput.value = resolvedLon;

          const components = Array.isArray(result.address_components) ? result.address_components : [];
          const neighborhood = components.find((c) => Array.isArray(c.types) && c.types.includes('neighborhood'));
          const sublocality = components.find((c) => Array.isArray(c.types) && c.types.includes('sublocality_level_1'));
          if (barrioInput) barrioInput.value = neighborhood?.long_name || sublocality?.long_name || barrioInput.value || 'Cali';

          return { lat: resolvedLat, lon: resolvedLon, resolved: true, source: 'Google' };
        }
      }
    } catch (e) {
      console.warn('Error con Google Geocoding:', e);
      if (provider === 'google') showToast('Google Maps no pudo encontrar la ubicación.', 'error');
    }
    if (provider === 'google') return null; // Si es solo Google y falla, no intentar con Nominatim
  }

  // 2. Fallback o elección directa de Nominatim
  if (tryNominatim) {
    console.info('Intentando geocodificar con Nominatim...');
    const nominatimResult = await geocodeAddressWithNominatim(address);
    if (nominatimResult) {
      if (latInput) latInput.value = nominatimResult.lat;
      if (lonInput) lonInput.value = nominatimResult.lon;
      if (barrioInput && !barrioInput.value) barrioInput.value = nominatimResult.barrio || 'Cali';
      if (nominatimResult.lat && nominatimResult.lon) showToast(`Dirección validada con Nominatim: ${nominatimResult.barrio}`, 'info');
      return { lat: nominatimResult.lat, lon: nominatimResult.lon, resolved: true, source: 'Nominatim' };
    }
  }

  // Si ninguna de las dos opciones funciona
  return null;
}

// ... (resto del código)

/**
 * Geocodifica una dirección usando la API de Nominatim de OpenStreetMap.
 * @param {string} address La dirección a geocodificar.
 * @returns {Promise<{lat: number, lon: number, barrio: string}|null>} Las coordenadas y el barrio, o null si falla.
 */
async function geocodeAddressWithNominatim(address) {
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const params = new URLSearchParams({
    q: `${address}, Cali, Colombia`, // Añadir contexto para mejorar la precisión
    format: 'json', // Queremos la respuesta en formato JSON
    limit: 1,       // Solo el mejor resultado
    'accept-language': 'es' // Preferir resultados en español
  });

  try {
    // ¡IMPORTANTE! Reemplaza con un identificador único de tu aplicación y un email de contacto.
    // Esto es un requisito de Nominatim para evitar bloqueos por abuso.
    const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': 'SISPED-SW-DesktopApp/1.0 (contact@yourdomain.com)' // Reemplaza con tu User-Agent real
      }
    });

    if (!response.ok) {
      console.error(`Nominatim API error: ${response.status} - ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data && data.length > 0) {
      const result = data[0];
      const lat = Number(result.lat);
      const lon = Number(result.lon);

      // Nominatim devuelve un objeto 'address' con varios niveles.
      // Intentamos extraer el barrio de forma heurística.
      let barrio = '';
      if (result.address) {
        barrio = result.address.neighbourhood || result.address.suburb || result.address.city_district || result.address.village || result.address.town || '';
      }

      return { lat, lon, barrio: barrio.trim() };
    } else {
      showToast('Nominatim no encontró resultados para esta dirección.', 'warning');
    }
  } catch (error) {
    console.error('Error geocodificando con Nominatim:', error);
    showToast('Error de conexión con el servicio Nominatim.', 'error');
  }
  return null;
}

// --- Utilidades de UI (Modales y Toasts) ---

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function showModal({ title, body, confirmText = 'Aceptar', cancelText = 'Cancelar', onConfirm, onCancel, isWide = false, footerConfirmText = null }) {
  const overlay = document.getElementById('modalOverlay');
  const content = overlay.querySelector('.modal-content');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const footerEl = document.getElementById('modalFooter');

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  footerEl.innerHTML = '';

  content.classList.toggle('wide', isWide);
  content.classList.toggle('order-modal-shell', String(body || '').includes('id="orderForm"'));
  content.classList.toggle('client-profile-shell', String(body || '').includes('id="clientProfileModal"'));

  if (cancelText) {
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = cancelText;
    btnCancel.onclick = () => {
      overlay.classList.remove('active');
      if (onCancel) onCancel();
    };
    footerEl.appendChild(btnCancel);
  }

  // Only create confirm button when a label is provided
  if (confirmText) {
    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'primary';
    btnConfirm.textContent = confirmText;
    btnConfirm.onclick = async () => {
      if (onConfirm) {
        const result = await onConfirm();
        if (result === false) return;
      }
      overlay.classList.remove('active');
    };
    footerEl.appendChild(btnConfirm);
  }

  // If no confirmText provided, but the modal body contains a form with its own submit
  // move the submit action to the footer to avoid visual overlap issues.
  if (!confirmText) {
    const form = bodyEl.querySelector('form');
    if (form) {
      // Try to find a submit button inside the form
      const nativeSubmit = form.querySelector('button[type="submit"], input[type="submit"]');
      // If a native submit exists, prefer it (do not hide it) so users clicking inside
      // the modal body trigger the form submit immediately. Only create a footer submit
      // when there is no native submit present.
      if (!nativeSubmit) {
        const footerSubmit = document.createElement('button');
        footerSubmit.type = 'button';
        footerSubmit.className = 'primary';
        footerSubmit.textContent = footerConfirmText || 'Guardar';
        footerSubmit.onclick = () => {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
            return;
          }

          const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
          const notCancelled = form.dispatchEvent(submitEvent);
          if (notCancelled && typeof form.submit === 'function') form.submit();
        };
        footerEl.appendChild(footerSubmit);
      }
    }
  }

  overlay.classList.add('active');
}

// ======= Plantillas locales (localStorage) =======
const TEMPLATES_KEY = 'sisped_order_templates_v1';

function loadLocalTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error leyendo plantillas desde localStorage', e);
    return [];
  }
}

function saveLocalTemplates(templates) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates || []));
  } catch (e) {
    console.error('Error guardando plantillas en localStorage', e);
  }
}

function showTemplatesModal(form) {
  const templates = loadLocalTemplates();

  const body = `
    <div style="display:flex;flex-direction:column;gap:12px;">
      <form id="templateCreateForm" style="display:flex;gap:8px;align-items:center;">
        <input id="templateNameInput" placeholder="Nombre de la plantilla" style="flex:1;padding:8px;border:1px solid var(--panel-border);border-radius:8px;" />
        <button type="submit" class="primary">Guardar</button>
      </form>
      <div id="templatesList" style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto;padding-right:6px;"></div>
    </div>
  `;

  showModal({ title: '📚 Plantillas (local)', body, cancelText: 'Cerrar', confirmText: null, isWide: false });

  // Attach handlers after modal content is rendered
  setTimeout(() => {
    const listEl = document.getElementById('templatesList');
    const formEl = document.getElementById('templateCreateForm');
    const nameInput = document.getElementById('templateNameInput');

    async function renderList() {
      let tpls = [];
      try {
        const serverTpls = await request('/api/templates');
        if (Array.isArray(serverTpls) && serverTpls.length) {
          tpls = serverTpls.map(s => ({ ...s, items: (typeof s.items === 'string' ? JSON.parse(s.items || '[]') : s.items) }));
        }
      } catch (e) {
        // No hay servidor o error -> usar localStorage
        tpls = loadLocalTemplates();
      }

      listEl.innerHTML = '';
      if (!tpls.length) {
        listEl.innerHTML = '<div style="color:var(--muted);">No hay plantillas guardadas.</div>';
        return;
      }

      tpls.forEach(t => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '8px';
        row.style.border = '1px solid var(--panel-border)';
        row.style.borderRadius = '8px';

        const left = document.createElement('div');
        left.innerHTML = `<strong>${escapeHtml(t.name)}</strong><div style="font-size:12px;color:var(--muted);margin-top:4px;">${(t.items||[]).map(i=>escapeHtml(i.name)+ ' x'+(i.quantity||1)).join(', ')}</div>`;
        left.style.flex = '1';

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn-secondary';
        applyBtn.textContent = 'Aplicar';
        applyBtn.onclick = () => {
          // Aplicar plantilla al formulario actual
          pendingItems.length = 0;
          (t.items || []).forEach(it => {
            pendingItems.push({
              productId: Number(it.productId || it.product_id),
              quantity: Number(it.quantity) || 1,
              name: it.name || 'Producto',
              unitPrice: Number(it.unitPrice || it.unit_price) || 0
            });
          });

          // Restaurar info de pago si viene
          if (form) {
            const paymentTypeField = form.querySelector('[name="paymentType"]');
            const paymentAmountField = form.querySelector('#paymentAmountInput');
            if (paymentTypeField && t.paymentType) paymentTypeField.value = t.paymentType;
            if (paymentAmountField && typeof t.paymentAmount !== 'undefined') paymentAmountField.value = Number(t.paymentAmount || 0);
          }

          renderPendingItemsInModal();
          // Cerrar modal
          document.getElementById('modalOverlay').classList.remove('active');
          showToast(`Plantilla "${t.name}" aplicada`, 'success');
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-secondary';
        delBtn.textContent = 'Borrar';
        delBtn.onclick = async () => {
          const confirmed = confirm(`Borrar plantilla "${t.name}"?`);
          if (!confirmed) return;
          // Intentar borrar en servidor, si falla borrar local
          try {
            if (t.id && String(t.id).length) {
              await request(`/api/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
            }
          } catch (e) {
            // ignore server error
          }

          const remaining = loadLocalTemplates().filter(x => x.id !== t.id);
          saveLocalTemplates(remaining);
          await renderList();
          showToast(`Plantilla "${t.name}" borrada`, 'info');
        };

        actions.appendChild(applyBtn);
        actions.appendChild(delBtn);

        row.appendChild(left);
        row.appendChild(actions);
        listEl.appendChild(row);
      });
    }

    formEl.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = (nameInput.value || '').trim();
      if (!name) {
        showToast('Ingresa un nombre para la plantilla', 'warning');
        return;
      }

      if (!pendingItems.length) {
        showToast('No hay items en la comanda para guardar como plantilla', 'warning');
        return;
      }

      const newTpl = {
        id: Date.now(),
        name,
        items: pendingItems.map(p => ({ productId: p.productId, quantity: p.quantity, name: p.name, unitPrice: p.unitPrice })),
        paymentType: (() => { try { return form.querySelector('[name="paymentType"]').value; } catch (e) { return null; } })(),
        paymentAmount: (() => { try { return Number(form.querySelector('#paymentAmountInput').value) || 0; } catch (e) { return null; } })()
      };
      // Intentar guardar en servidor; si falla, guardar localmente
      let saved = false;
      try {
        const serverResp = await request('/api/templates', { method: 'POST', body: JSON.stringify({ name: newTpl.name, items: newTpl.items, paymentType: newTpl.paymentType, paymentAmount: newTpl.paymentAmount }) });
        if (serverResp && serverResp.id) {
          // servidor devolvió la plantilla persistida
          const currentLocal = loadLocalTemplates();
          // mantener copia local con id del servidor
          currentLocal.unshift({ ...newTpl, id: serverResp.id });
          saveLocalTemplates(currentLocal);
          saved = true;
        }
      } catch (e) {
        // guardar local como fallback
      }

      if (!saved) {
        const current = loadLocalTemplates();
        current.unshift(newTpl);
        saveLocalTemplates(current);
      }

      nameInput.value = '';
      await renderList();
      showToast(`Plantilla "${newTpl.name}" guardada`, 'success');
    });

    renderList();
  }, 30);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function(m) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]); });
}

// ==============================================

function closeModals() {
  document.getElementById('modalOverlay').classList.remove('active');
  // Limpiar campos si es necesario
}

function openOrderModal(order = null) {
  pendingItems.length = 0;
  if (order && order.items) {
    order.items.forEach(i => {
      pendingItems.push({
        productId: i.product_id,
        quantity: i.quantity,
        name: i.name_snapshot,
        unitPrice: i.unit_price
      });
    });
  }

  const template = document.getElementById('orderFormTemplate');
  showModal({
    title: order ? `Editar Comanda #${order.id}` : 'Nueva comanda',
    body: template.innerHTML,
    confirmText: null,
    cancelText: 'Cerrar',
    isWide: true,
    footerConfirmText: order ? 'Guardar cambios' : 'Crear comanda'
  });

  queueMicrotask(() => {
    const modalBody = document.querySelector('.modal-body');
    if (typeof attachOrderFormEvents === 'function') attachOrderFormEvents(modalBody, order);
    if (typeof renderPendingItemsInModal === 'function') renderPendingItemsInModal();
  });
}

// Setup opener for the order modal — attach after DOM is ready
function setupOrderModalOpener() {
  const openBtn = document.getElementById('openOrderModal');
  if (openBtn) openBtn.addEventListener('click', () => openOrderModal());
}

function syncOrderMessage(message, isError = false) {
  // Redirigimos esto a Toasts para mayor visibilidad
  showToast(message, isError ? 'error' : 'success');

  // Mantenemos el mensaje en el form por si acaso
  const element = document.getElementById('orderMessage');
  if (element) {
    element.textContent = message;
    element.style.color = isError ? '#fecaca' : '#bfdbfe';
  }
}

async function renderClientHistory(clientId, container) {
  container.innerHTML = '<div class="subtle">Cargando historial...</div>';
  try {
    const orders = await request(`/api/clients/${clientId}/orders`);
    if (!orders.length) {
      container.innerHTML = '<div class="subtle">Sin pedidos registrados.</div>';
      return;
    }

    container.innerHTML = generateClientOrderHistory(orders);
  } catch (e) {
    console.error('Error al cargar historial del cliente:', e);
    container.innerHTML = `
      <div class="error" style="color: var(--danger); font-size: 0.85rem;">
        Error al cargar historial: ${e.message}
      </div>`;
  }
}

async function renderClientInsights(clientId, container, client = null) {
  if (!container) return;
  container.innerHTML = '<div class="subtle">Analizando cliente...</div>';

  try {
    const orders = await request(`/api/clients/${clientId}/orders`);
    const loyalty = calculateClientLoyalty(client || { created_at: new Date().toISOString() }, orders);
    const preferences = analyzeClientPreferences(orders);

    container.innerHTML = `
      <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;">
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--panel-border); border-radius: 12px; padding: 12px;">
          <div class="subtle" style="font-size: 10px; text-transform: uppercase;">Fidelidad</div>
          <div style="font-size: 22px; font-weight: 800; color: var(--accent); margin-top: 4px;">${loyalty.loyaltyScore}</div>
          <div class="subtle" style="font-size: 11px; margin-top: 4px;">${loyalty.segment} · ${loyalty.ordersCount} pedidos</div>
        </div>
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--panel-border); border-radius: 12px; padding: 12px;">
          <div class="subtle" style="font-size: 10px; text-transform: uppercase;">Valor</div>
          <div style="font-size: 22px; font-weight: 800; color: var(--text-primary); margin-top: 4px;">${money(loyalty.totalSpent)}</div>
          <div class="subtle" style="font-size: 11px; margin-top: 4px;">${loyalty.monthsActive} meses activo(s)</div>
        </div>
      </div>
      <div style="margin-top: 10px; display:flex; flex-direction:column; gap: 8px;">
        <div style="display:flex; justify-content:space-between; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--panel-border); border-radius: 12px;">
          <span class="subtle">Producto favorito</span>
          <strong>${preferences.favoriteProduct ? `${escapeHtml(preferences.favoriteProduct.name)} x${preferences.favoriteProduct.quantity}` : 'Sin datos'}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--panel-border); border-radius: 12px;">
          <span class="subtle">Zona favorita</span>
          <strong>${preferences.favoriteZone ? `${escapeHtml(preferences.favoriteZone.name)} (${preferences.favoriteZone.visits})` : 'Sin datos'}</strong>
        </div>
        <div style="display:flex; justify-content:space-between; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.02); border: 1px solid var(--panel-border); border-radius: 12px;">
          <span class="subtle">Tasa de repetición</span>
          <strong>${preferences.repeatRate}%</strong>
        </div>
      </div>
    `;
  } catch (error) {
    container.innerHTML = `<div class="error" style="color: var(--danger); font-size: 0.85rem;">Error al analizar cliente: ${error.message}</div>`;
  }
}

function renderClientResults(clients) {
  const container = document.getElementById('clientResults');
  if (!container) return; // UI section removed — skip rendering

  if (!clients.length) {
    container.innerHTML = '<div class="subtle">Sin coincidencias.</div>';
    return;
  }

  container.innerHTML = clients.map((client) => `
    <article class="card">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h4 style="margin:0;">${client.name}</h4>
          <div class="meta">${client.phone} · ${client.address_count || 0} dirección(es)</div>
        </div>
        <button type="button" class="btn-secondary" data-client-edit="${client.id}">Editar</button>
      </div>
      <div class="subtle" style="margin-top:8px;">
        ${client.primaryAddress ? `📍 ${client.primaryAddress.address} (${client.primaryAddress.barrio})` : '⚠️ Sin dirección principal'}
      </div>
    </article>
  `).join('');
}

async function renderClients() {
  const tbody = document.getElementById('clientsListTable');
  const paginationContainer = document.getElementById('clientsPagination');
  if (!tbody) return;

  let filtered = dashboardState.clients;
  const term = clientsTableState.searchTerm.toLowerCase();
  if (term) {
    filtered = filtered.filter(c =>
      c.name.toLowerCase().includes(term) ||
      c.phone.includes(term)
    );
  }

  // Renderizar KPIs de clientes
  const totalClients = dashboardState.clients.length;
  const frequentClients = dashboardState.clients.filter(c => (c.order_count || 0) > 3).length;
  const kpiTotal = document.getElementById('kpiTotalClients');
  const kpiFreq = document.getElementById('kpiFrequentClients');
  if (kpiTotal) kpiTotal.textContent = totalClients;
  if (kpiFreq) kpiFreq.textContent = frequentClients;

  // Lógica de Paginación
  const page = clientsTableState.page || 1;
  const pageSize = clientsTableState.pageSize || 10;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  tbody.innerHTML = pageItems.map(c => `
    <tr class="orders-row client-row ${clientsTableState.selectedId === c.id ? 'selected' : ''}" data-client-id="${c.id}">
      <td><div style="font-weight:700;">${escapeHtml(c.name)}</div></td>
      <td class="subtle">${escapeHtml(c.phone)}</td>
      <td class="subtle">${escapeHtml(c.primaryAddress?.barrio || 'N/A')} · ${escapeHtml(c.primaryAddress?.address || '')}</td>
      <td style="text-align:right;"><strong>${c.addressCount ?? c.address_count ?? 0}</strong> direcciones</td>
    </tr>
  `).join('');

  // Renderizar paginación de clientes
  if (paginationContainer) {
    paginationContainer.innerHTML = Array.from({ length: pages }, (_, i) =>
      `<button class="page-btn ${i + 1 === page ? 'active' : ''}" data-page="${i + 1}">${i + 1}</button>`
    ).join('');
    paginationContainer.querySelectorAll('.page-btn').forEach(btn => btn.addEventListener('click', () => {
      clientsTableState.page = Number(btn.dataset.page);
      renderClients();
    }));
  }

  const rangeEl = document.getElementById('clientsTableRange');
  if (rangeEl) rangeEl.textContent = `${start + 1} - ${Math.min(start + pageSize, total)} de ${total}`;

  tbody.querySelectorAll('.client-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.clientId);
      clientsTableState.selectedId = id;
      const client = dashboardState.clients.find(c => c.id === id);
      showClientDetail(client);
      renderClients(); // Refrescar para highlight
    });
  });
}

async function showClientDetail(client) {
  // Cargar direcciones adicionales del cliente
  let addresses = [];
  try {
    addresses = await request(`/api/clients/${client.id}/addresses`);
  } catch (e) { console.error(e); }

  const isArchived = Number(client.archived) === 1;
  const addressCards = addresses.length
    ? addresses.map((addr) => `
      <article class="client-address-card ${addr.is_primary ? 'is-primary' : ''}">
        <div class="client-address-card-head">
          <div>
            <div class="client-chip-row">
              <span class="client-card-chip">${escapeHtml(addr.label || 'Dirección')}</span>
              ${addr.is_primary ? '<span class="client-card-chip accent">Principal</span>' : ''}
            </div>
            <div class="client-address-text">${escapeHtml(addr.address)}</div>
            <div class="client-address-subtext">${escapeHtml(addr.barrio || '')}</div>
            ${addr.reference ? `<div class="client-address-reference">"${escapeHtml(addr.reference)}"</div>` : ''}
          </div>
          <div class="client-address-actions">
            <button type="button" class="icon-button client-address-action-btn" data-action="edit" data-id="${addr.id}" title="Editar"><span class="material-symbols-rounded">edit</span></button>
            ${addr.source !== 'order' ? `<button type="button" class="icon-button client-address-action-btn danger" data-action="delete" data-id="${addr.id}" title="Eliminar"><span class="material-symbols-rounded">delete</span></button>` : ''}
          </div>
        </div>
        ${addr.source !== 'order' && !addr.is_primary ? `<button type="button" class="client-secondary-action client-address-action-btn" data-action="set-primary" data-id="${addr.id}">Marcar como principal</button>` : ''}
      </article>
    `).join('')
    : '<div class="subtle">No hay direcciones guardadas.</div>';

  const recentOrders = (client.recentOrders || client.recent_orders || []).slice ? (client.recentOrders || client.recent_orders || []) : [];

  const body = `
    <div id="clientProfileModal" class="client-profile-modal">
      <section class="client-profile-hero">
        <div class="client-profile-avatar">${escapeHtml((client.name || '?').charAt(0))}</div>
        <div class="client-profile-copy">
          <div class="client-profile-name-row">
            <h3>${escapeHtml(client.name)}</h3>
            ${isArchived ? '<span class="client-card-chip danger">Archivado</span>' : ''}
          </div>
          <div class="client-profile-phone">${escapeHtml(client.phone || '')}</div>
          <div class="client-profile-meta">${escapeHtml(client.primaryAddress?.address || 'Sin dirección principal')} · ${escapeHtml(client.primaryAddress?.barrio || 'Sin barrio')}</div>
        </div>
        <div class="client-profile-actions">
          <button type="button" class="primary" id="editClientDetailBtn"><span class="material-symbols-rounded">edit</span> Editar información</button>
          <button type="button" class="btn-danger" id="deleteClientDetailBtn"><span class="material-symbols-rounded">delete</span> Eliminar cliente</button>
        </div>
      </section>

      <section class="client-profile-grid">
        <article class="client-profile-panel">
          <div class="client-panel-head">
            <h4>Direcciones guardadas</h4>
            <button type="button" class="client-panel-link" id="addAddressBtn"><span class="material-symbols-rounded">add_location</span> Agregar</button>
          </div>
          <div class="client-address-list">${addressCards}</div>
        </article>

        <article class="client-profile-panel">
          <div class="client-panel-head"><h4>Notas internas</h4></div>
          <div class="client-notes">${escapeHtml(client.notes || 'Sin notas registradas')}</div>

          <div class="client-panel-spacer"></div>

          <div class="client-panel-head"><h4>Fidelidad y preferencias</h4></div>
          <div class="mini-list client-profile-mini-list" id="clientInsightsList">Cargando...</div>
        </article>
      </section>

      <section class="client-profile-panel">
        <div class="client-panel-head"><h4>Historial reciente</h4></div>
        <div class="mini-list client-profile-mini-list" id="clientHistoryList">Cargando...</div>
      </section>
    </div>
  `;

  showModal({
    title: 'Perfil del Cliente',
    body,
    confirmText: null,
    cancelText: 'Cerrar',
    isWide: true
  });

  const modalBody = document.querySelector('.modal-body');
  const editBtn = modalBody.querySelector('#editClientDetailBtn');
  const deleteBtn = modalBody.querySelector('#deleteClientDetailBtn');
  const addBtn = modalBody.querySelector('#addAddressBtn');

  if (editBtn) editBtn.onclick = () => openClientModal(client);

  if (deleteBtn) {
    deleteBtn.onclick = () => {
      showModal({
        title: '¿Eliminar cliente?',
        body: `¿Seguro que deseas eliminar a <strong>${escapeHtml(client.name)}</strong>? Esta acción no se puede deshacer.`,
        confirmText: 'Sí, eliminar',
        cancelText: 'Cancelar',
        onConfirm: async () => {
          try {
            await deleteClient(client.id);
            clientsTableState.selectedId = null;
            showToast('Cliente eliminado', 'success');
            await refreshDashboard();
          } catch (error) {
            showToast(error.message, 'error');
          }
        }
      });
    };
  }

  if (addBtn) addBtn.onclick = () => openAddressModal(client.id);

  modalBody.querySelectorAll('.client-address-action-btn').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.action;
      const addrId = btn.dataset.id;
      const addr = addresses.find(a => String(a.id) === addrId);

      if (action === 'edit') {
        openAddressModal(client.id, addr);
      } else if (action === 'delete') {
        showModal({
          title: '¿Eliminar dirección?',
          body: `¿Estás seguro de eliminar "${escapeHtml(addr.address)}"?`,
          confirmText: 'Sí, eliminar',
          onConfirm: async () => {
            await request(`/api/addresses/${addrId}`, { method: 'DELETE' });
            showClientDetail(client);
            await refreshDashboard();
          }
        });
      } else if (action === 'set-primary') {
        await request(`/api/addresses/${addrId}/primary`, { method: 'PATCH' });
        showClientDetail(client);
        await refreshDashboard();
      }
    };
  });

  renderClientInsights(client.id, modalBody.querySelector('#clientInsightsList'), client);
  renderClientHistory(client.id, modalBody.querySelector('#clientHistoryList'));
}

function openAddressModal(clientId, address = null) {
  const body = `
    <form id="addressForm" class="order-form">
      <input type="hidden" name="latitude" value="${address?.latitude || ''}" />
      <input type="hidden" name="longitude" value="${address?.longitude || ''}" />
      <div class="form-grid-modal">
        <div class="stack-form">
          <label class="subtle">Etiqueta (Ej: Casa, Oficina)</label>
          <input name="label" type="text" value="${escapeHtml(address?.label || '')}" placeholder="Casa" required />
        </div>
        <div class="stack-form">
          <label class="subtle">Barrio</label>
          <div class="input-with-loader">
            <input name="barrio" type="text" value="${escapeHtml(address?.barrio || '')}" placeholder="Esperando dirección..." required readonly />
            <div class="loader-spinner"></div>
            <button type="button" class="edit-barrio-btn" title="Editar zona manualmente"><span class="material-symbols-rounded" style="font-size: 18px;">edit</span></button>
          </div>
        </div>
      </div>
      <div class="stack-form">
        <label class="subtle">Dirección completa</label>
        <input name="address" type="text" value="${escapeHtml(address?.address || '')}" placeholder="Calle / Carrera # Numero" required />
        <input type="hidden" name="geocodingSource" value="${address?.geocoding_source || ''}" />
        <button type="button" class="mini-action" id="validateAddressModalBtn" style="margin-top: 8px;"><span class="material-symbols-rounded" style="font-size: 16px;">location_searching</span> Validar</button>
      </div>
      <div class="stack-form">
        <label class="subtle">Referencia / Detalle</label>
        <input name="reference" type="text" value="${escapeHtml(address?.reference || '')}" placeholder="Apto, Casa color azul, etc." />
      </div>
    </form>
    <input type="hidden" name="geocodingSource" value="${address?.geocoding_source || ''}" />
  `;

  showModal({
    title: address ? 'Editar Dirección' : 'Agregar Nueva Dirección',
    body,
    confirmText: 'Guardar Dirección',
    cancelText: 'Cancelar',
    onConfirm: async () => {
      const form = document.getElementById('addressForm');
      const data = getFormData(form);
      let geocodingSource = form.querySelector('[name="geocodingSource"]')?.value || '';

      // Si no hay coordenadas, intentar geocodificar antes de guardar
      if (!data.latitude || !data.longitude) {
        const resolved = await resolveOrderLocation(form);
        if (resolved) {
          data.latitude = resolved.lat;
          data.longitude = resolved.lon;
          geocodingSource = resolved.source;
        } else {
          showToast('No se pudo validar la dirección. Intenta de nuevo.', 'error');
          return;
        }
      }

      try {
        if (address) {
          await request(`/api/addresses/${address.id}`, { method: 'PATCH', body: JSON.stringify({ ...data, geocodingSource }) });
        } else {
          await request(`/api/clients/${clientId}/addresses`, { method: 'POST', body: JSON.stringify({ ...data, geocodingSource }) });
        }
        showToast('Dirección guardada', 'success');
        closeModals();
        await refreshDashboard();
        const client = dashboardState.clients.find(c => Number(c.id) === Number(clientId));
        if (client) showClientDetail(client);
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });
  const modalBody = document.getElementById('modalBody');
  attachGeocoding(modalBody);

  // Evento para el botón de validar dirección en el modal de dirección
  const validateBtn = modalBody.querySelector('#validateAddressModalBtn');
  if (validateBtn) validateBtn.addEventListener('click', async () => {
    const form = document.getElementById('addressForm');
    const resolved = await resolveOrderLocation(form);
    if (resolved) form.querySelector('[name="geocodingSource"]').value = resolved.source;
  });
}

function renderProducts(products) {
  const container = document.getElementById('productsList');
  const select = document.getElementById('orderProductSelect');

  // Actualizar KPIs de productos (Estilo SaaS)
  const kpiTotal = document.getElementById('kpiTotalProducts');
  const kpiActive = document.getElementById('kpiActiveProducts');
  const kpiCategories = document.getElementById('kpiCategories');

  if (kpiTotal) kpiTotal.textContent = products.length;
  if (kpiActive) kpiActive.textContent = products.filter(p => Number(p.active) === 1).length;
  if (kpiCategories) kpiCategories.textContent = new Set(products.map(p => p.category)).size;

  // Filtrar productos por búsqueda
  let filtered = products;
  const term = (productsTableState.searchTerm || '').toLowerCase().trim();
  if (term) {
    filtered = filtered.filter(p => p.name.toLowerCase().includes(term) || (p.category || '').toLowerCase().includes(term));
  }

  const getProductCard = (product) => {
    const comboItems = parseComboItems(product.combo_items || '[]');
    const isCombo = comboItems.length > 0 || String(product.category || '').toLowerCase().includes('combo');
    const comboPreview = comboItems.length ? comboItems.slice(0, 3).join(' · ') : 'Sin detalle de combo';

    return `
      <article class="product-card" data-active="${product.active ? '1' : '0'}">
        <div class="product-card-top">
          <div>
            <div class="product-card-title-row">
              <h4>${escapeHtml(product.name)}</h4>
              <span class="product-state ${product.active ? 'is-active' : 'is-inactive'}">${product.active ? 'Activo' : 'Inactivo'}</span>
              ${isCombo ? '<span class="product-badge combo">Combo</span>' : '<span class="product-badge individual">Individual</span>'}
            </div>
            <div class="product-card-meta">${escapeHtml(product.category)} · ${money(product.price)}</div>
          </div>
          <div class="product-price">${money(product.price)}</div>
        </div>

        <div class="product-card-body">
          <div class="product-detail-label">Información del ítem</div>
          <p>${isCombo ? `Incluye ${comboItems.length} ítem(s) detallados en el combo familiar.` : 'Producto estándar disponible para venta individual.'}</p>
          <div class="combo-preview">${escapeHtml(comboPreview)}</div>
        </div>

        <div class="product-card-actions">
          <button type="button" data-product-toggle="${product.id}" data-active="${product.active ? '0' : '1'}" class="mini-action toggle ${product.active ? 'active' : ''}">${product.active ? 'Desactivar' : 'Activar'}</button>
          <button type="button" data-product-edit="${product.id}" class="mini-action edit">Editar</button>
          <button type="button" data-product-delete="${product.id}" class="mini-action danger">Eliminar</button>
        </div>
      </article>
    `;
  };

  // Agrupar por categoría para una navegación más cómoda
  const byCategory = {};
  filtered.forEach(p => {
    const cat = (p.category || 'Otros').trim();
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  });

  const categories = Object.keys(byCategory).sort((a, b) => byCategory[b].length - byCategory[a].length);

  // Construir barra de categorías dinámicas
  const activeOnly = (productsTableState.showActiveOnly === true);

  const categoryPillsMarkup = [
    `<button class="cat-pill ${productsViewCategory==='all' ? 'active' : ''}" data-cat="all">Todos (${filtered.length})</button>`,
    ...categories.map(c => `<button class="cat-pill ${productsViewCategory===c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${byCategory[c].length})</button>`)
  ].join('');

  const categoryHeader = `
    <div class="product-category-bar" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      ${categoryPillsMarkup}
    </div>
  `;

  // Construir secciones por categoría (si se seleccionó 'all' o una categoría específica)
  let html = '';
  if (productsViewCategory === 'all') {
    html += categoryHeader;
    categories.forEach(cat => {
      const items = byCategory[cat] || [];
      html += `
        <section class="product-group">
          <div class="product-group-header">
            <div>
              <h3>${escapeHtml(cat)}</h3>
              <p>${items.length} producto(s)</p>
            </div>
          </div>
          <div class="product-group-list">
            ${items.length ? items.map(getProductCard).join('') : `<div class="product-group-empty">No hay productos en esta categoría</div>`}
          </div>
        </section>
      `;
    });
  } else {
    // Categoria específica
    const items = byCategory[productsViewCategory] || [];
    html += categoryHeader;
    html += `
      <section class="product-group">
        <div class="product-group-header">
          <div>
            <h3>${escapeHtml(productsViewCategory)}</h3>
            <p>${items.length} producto(s)</p>
          </div>
        </div>
        <div class="product-group-list">
          ${items.length ? items.map(getProductCard).join('') : `<div class="product-group-empty">No hay productos en esta categoría</div>`}
        </div>
      </section>
    `;
  }

  if (container) {
    container.innerHTML = html;
  }

  if (select) {
    select.innerHTML = products
      .filter((product) => Number(product.active) === 1)
      .map((product) => `<option value="${product.id}">${product.name} - ${money(product.price)}</option>`)
      .join('');
  }

  document.querySelectorAll('[data-products-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.productsFilter === productsViewFilter);
  });

  // Attach category pill handlers (delegation)
  document.querySelectorAll('.product-category-bar .cat-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cat = btn.dataset.cat;
      productsViewCategory = cat;
      renderProducts(products);
    });
  });
}

function buildDriverModalBody(driver = null) {
  return `
    <form id="driverModalForm" class="order-form product-form">
      <div class="product-form-hero">
        <div>
          <p class="eyebrow">Domiciliarios</p>
          <h3>${driver ? 'Editar domiciliario' : 'Nuevo domiciliario'}</h3>
        </div>
        <div class="combo-switch">
          <span>
            <strong>Operativo</strong>
            <small>Activa o desactiva su disponibilidad para rutas.</small>
          </span>
        </div>
      </div>

      <div class="form-grid-modal product-form-grid">
        <div class="stack-form">
          <label class="subtle">Nombre</label>
          <input name="name" type="text" placeholder="Ej: Carlos Gomez" value="${escapeHtml(driver?.name || '')}" required />
        </div>
        <div class="stack-form">
          <label class="subtle">Teléfono</label>
          <input name="phone" type="text" placeholder="Ej: 3205551001" value="${escapeHtml(driver?.phone || '')}" />
        </div>
      </div>

      <div class="form-grid-modal product-form-grid">
        <div class="stack-form">
          <label class="subtle">Vehículo</label>
          <input name="vehicle" type="text" placeholder="Moto" value="${escapeHtml(driver?.vehicle || 'Moto')}" />
        </div>
      </div>

      <div class="form-grid-modal product-form-grid">
        <div class="stack-form">
          <label class="subtle">Estado operativo</label>
          <select name="currentStatus">
            <option value="disponible" ${!driver || String(driver.current_status) === 'disponible' ? 'selected' : ''}>Disponible</option>
            <option value="en ruta" ${driver && String(driver.current_status) === 'en ruta' ? 'selected' : ''}>En ruta</option>
            <option value="inactivo" ${driver && String(driver.current_status) === 'inactivo' ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
        <div class="stack-form">
          <label class="subtle">Disponibilidad</label>
          <select name="active">
            <option value="1" ${!driver || Number(driver.active) === 1 ? 'selected' : ''}>Activo</option>
            <option value="0" ${driver && Number(driver.active) === 0 ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
      </div>
    </form>
  `;
}

function openDriverModal(driver = null) {
  showModal({
    title: driver ? 'Editar Domiciliario' : 'Nuevo Domiciliario',
    body: buildDriverModalBody(driver),
    confirmText: null,
    cancelText: 'Cancelar',
    isWide: false
  });

  queueMicrotask(() => {
    const form = document.getElementById('driverModalForm');
    if (!form) {
      return;
    }

    form.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const data = getFormData(form);

      try {
        if (driver) {
          await request(`/api/drivers/${driver.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: data.name,
              phone: data.phone,
              vehicle: data.vehicle,
              active: data.active === '1',
              currentStatus: data.currentStatus
            })
          });
          showToast('Domiciliario actualizado', 'success');
        } else {
          await request('/api/drivers', {
            method: 'POST',
            body: JSON.stringify({
              name: data.name,
              phone: data.phone,
              vehicle: data.vehicle,
              active: data.active === '1'
            })
          });
          showToast('Domiciliario creado', 'success');
        }

        closeModals();
        await refreshDashboard();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }, { once: true });
  });
}

function renderDrivers(drivers) {
  const container = document.getElementById('driversList');
  if (!container) return;
  
  const orderDriverSelect = document.getElementById('orderDriverSelect');

  // Filtrar por búsqueda
  let filtered = drivers;
  const term = (driversTableState.searchTerm || '').toLowerCase().trim();
  if (term) {
    filtered = filtered.filter(d => 
      d.name.toLowerCase().includes(term) || 
      (d.phone || '').includes(term)
    );
  }

  // Actualizar KPIs de domiciliarios (Estilo SaaS)
  const kpiTotal = document.getElementById('kpiTotalDrivers');
  const kpiActive = document.getElementById('kpiActiveDrivers');
  const kpiOnRoute = document.getElementById('kpiOnRouteDrivers');

  if (kpiTotal) kpiTotal.textContent = drivers.length;
  if (kpiActive) kpiActive.textContent = drivers.filter(d => Number(d.active) === 1).length;
  if (kpiOnRoute) kpiOnRoute.textContent = drivers.filter(d => String(d.current_status) === 'en ruta').length;

  const activeDrivers = filtered.filter((d) => Number(d.active) === 1);
  const inactiveDrivers = filtered.filter((d) => Number(d.active) !== 1);

  // Actualizar selector en la comanda (usando los reales sin filtro de búsqueda)
  if (orderDriverSelect) {
    const realActive = drivers.filter(d => Number(d.active) === 1);
    orderDriverSelect.innerHTML = '<option value="">Sin asignar (despacho manual)</option>' +
      realActive.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  }

  const renderDriverCard = (driver) => {
    const status = String(driver.current_status || 'disponible').toLowerCase();
    const statusIcon = status === 'en ruta' ? 'local_shipping' : (status === 'disponible' ? 'check_circle' : 'pause_circle');
    const statusColor = status === 'en ruta' ? 'var(--accent)' : (status === 'disponible' ? 'var(--success)' : 'var(--muted)');

    return `
      <article class="driver-card" style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); border-radius: 16px; padding: 20px; transition: all 0.2s ease; display: flex; flex-direction: column; gap: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="display: flex; gap: 14px; align-items: center;">
            <div style="width: 48px; height: 48px; border-radius: 12px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 20px;">
              ${driver.vehicle === 'Moto' ? '🛵' : '🚗'}
            </div>
            <div>
              <h4 style="margin: 0; font-size: 16px; font-weight: 700;">${escapeHtml(driver.name)}</h4>
              <div class="subtle" style="font-size: 12px; margin-top: 2px;">${escapeHtml(driver.phone || 'Sin teléfono')}</div>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px;">
            <span class="driver-state ${driver.active ? 'is-active' : 'is-inactive'}" style="font-size: 10px;">${driver.active ? 'Activo' : 'Inactivo'}</span>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: ${statusColor}; text-transform: uppercase;">
              <span class="material-symbols-rounded" style="font-size: 16px;">${statusIcon}</span>
              ${status}
            </div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr; gap: 12px; background: rgba(0,0,0,0.15); padding: 12px; border-radius: 12px; border: 1px solid var(--panel-border);">
          <div>
            <div class="subtle" style="font-size: 9px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.05em;">Vehículo</div>
            <div style="font-size: 13px; font-weight: 600; margin-top: 2px;">${escapeHtml(driver.vehicle)}</div>
          </div>
        </div>

        <div class="driver-card-actions" style="border-top: 1px solid var(--panel-border); padding-top: 16px; display: flex; gap: 8px;">
          <button type="button" data-driver-toggle="${driver.id}" data-active="${driver.active ? '0' : '1'}" class="mini-action" style="flex: 1; border-color: ${driver.active ? 'var(--danger)' : 'var(--success)'}; color: ${driver.active ? 'var(--danger)' : 'var(--success)'}; opacity: 0.8;">
            ${driver.active ? 'Pausar' : 'Activar'}
          </button>
          <button type="button" data-driver-edit="${driver.id}" class="mini-action" style="flex: 1;">Editar</button>
          <button type="button" data-driver-delete="${driver.id}" class="mini-action danger" style="padding: 8px;"><span class="material-symbols-rounded" style="font-size: 18px;">delete</span></button>
        </div>
      </article>
    `;
  };

  const getGroupMarkup = (title, items, emptyMessage) => `
    <section class="driver-group" style="margin-bottom: 32px;">
      <div class="driver-group-header" style="margin-bottom: 16px;">
        <div style="display: flex; align-items: baseline; gap: 10px;">
          <h3 style="font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);">${title}</h3>
          <span class="insight-chip neutral" style="font-size: 10px;">${items.length}</span>
        </div>
      </div>
      <div class="driver-group-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px;">
        ${items.length ? items.map(renderDriverCard).join('') : `<div class="product-group-empty" style="grid-column: 1/-1;">${emptyMessage}</div>`}
      </div>
    </section>
  `;

  container.innerHTML = `
    <div>
      ${getGroupMarkup('Domiciliarios en turno', activeDrivers, 'No hay personal activo que coincida con los filtros.')}
      ${getGroupMarkup('Personal fuera de servicio', inactiveDrivers, 'No hay personal inactivo registrado.')}
    </div>
  `;
}

function renderPendingItems() {
  const container = document.getElementById('pendingItems');

  if (!container) return;

  if (!pendingItems.length) {
    container.innerHTML = '<div class="subtle">No hay productos agregados a la comanda.</div>';
    return;
  }

  const total = pendingItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);

  const itemsHtml = pendingItems.map((item, index) => `
    <div class="row">
      <div style="flex: 1;">
        <strong>${item.name}</strong>
        ${item.isCombo ? `<div class="subtle" style="font-size: 0.75rem; margin-top: 2px;">📦 Incluye: ${item.comboInfo}</div>` : ''}
      </div>
      <div class="meta">Cantidad: ${item.quantity} · ${money(item.unitPrice)} · ${money(item.quantity * item.unitPrice)}</div>
      <button type="button" data-item-remove="${index}">Quitar</button>
    </div>
  `).join('');
  // No renderizamos el total aquí: el resumen financiero está en el panel derecho
  container.innerHTML = itemsHtml;
}

function renderOrders(orders) {
  const container = document.getElementById('ordersList');
  if (!container) return;

  // If the orders view is active, render a table with pagination
  const ordersPanel = container.closest('.view-panel');
  const isOrdersView = ordersPanel && ordersPanel.id === 'ordersView';

  if (isOrdersView) {
    renderOrdersTable(orders);
    return;
  }

  // otherwise render as timeline (overview)
  container.classList.add('timeline');
  container.innerHTML = orders
    .slice()
    .sort((a, b) => parseBogotaDate(b.created_at) - parseBogotaDate(a.created_at))
    .map((order) => {
      const statusClass = getOrderStatusClass(order.status);
      const iconClass = getOrderIconClass(order.status);
      const priorityClass = getOrderPriorityClass(order);
      const priorityLabel = getOrderPriorityLabel(order);

      return `
    <article class="timeline-item" data-status="${String(order.status || '').toLowerCase()}">
      <div class="timeline-icon ${iconClass}">${getOrderIcon(order.status)}</div>
      <div class="timeline-body">
        <h4>Pedido #${order.id} · <span class="meta">${order.client_name}</span></h4>
        <div class="timeline-meta">${order.client_phone} · ${order.barrio} · ${order.address}</div>
        <div class="tag-row" style="margin-top:8px;">
          <span class="tag">${money(order.total)}</span>
          <span class="tag ${statusClass}">${order.status}</span>
        </div>
        <div class="order-actions" style="margin-top: 8px;">
          <select class="status-changer" data-order-id="${order.id}">
            <option value="nuevo" ${order.status === 'nuevo' ? 'selected' : ''}>Nuevo</option>
            <option value="en preparación" ${order.status === 'en preparación' ? 'selected' : ''}>En preparación</option>
            <option value="listo para salir" ${order.status === 'listo para salir' ? 'selected' : ''}>Listo para salir</option>
            <option value="en ruta" ${order.status === 'en ruta' ? 'selected' : ''}>En ruta</option>
            <option value="entregado" ${order.status === 'entregado' ? 'selected' : ''}>Entregado</option>
            <option value="cancelado" ${order.status === 'cancelado' ? 'selected' : ''}>Cancelado</option>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
        <span class="priority-badge ${priorityClass}">${priorityLabel}</span>
        <span class="subtle">${formatBogotaDateTime(order.created_at)}</span>
      </div>
    </article>
  `;
    })
    .join('');
}

function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersList');
  const paginationContainer = document.getElementById('ordersPagination');
  const tableRange = document.getElementById('tableRange');
  const tableTotal = document.getElementById('tableTotal');
  if (!tbody) return;

  // Aplicar filtro de estado
  // 1. Filtrar por término de búsqueda (ID)
  let filtered = orders;
  const term = (ordersTableState.searchTerm || '').trim();
  if (term) {
    filtered = filtered.filter(o => String(o.id).includes(term));
  }

  // 2. Aplicar filtro de estado
  const currentFilter = ordersTableState.filter || 'all';
  if (currentFilter !== 'all') {
    filtered = filtered.filter(o => {
      const s = String(o.status || '').toLowerCase();
      if (currentFilter === 'preparing') return s.includes('prepar') || s.includes('nuevo') || s.includes('listo');
      if (currentFilter === 'route') return s.includes('ruta');
      if (currentFilter === 'delivered') return s.includes('entreg');
      return true;
    });
  }

  const page = ordersTableState.page || 1;
  const pageSize = ordersTableState.pageSize || 8;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice().sort((a, b) => parseBogotaDate(b.created_at) - parseBogotaDate(a.created_at)).slice(start, start + pageSize);

  // build table rows
  tbody.innerHTML = pageItems.map(o => `
    <tr class="orders-row" data-order-id="${o.id}">
      <td class="col-id">#${o.id}</td>
      <td class="col-client"><div class="client-name">${escapeHtml(o.client_name)}</div><div class="subtle client-phone">${escapeHtml(o.client_phone || '')}</div></td>
      <td class="col-address"><div class="subtle">${escapeHtml(o.barrio || '')} · ${escapeHtml(o.address || '')}</div></td>
      <td class="col-status"><span class="order-status-badge ${getOrderStatusClass(o.status)}">${escapeHtml(o.status || '')}</span></td>
      <td class="col-total"><strong>${money(o.total)}</strong></td>
      <td class="col-time"><div class="subtle">${formatBogotaTime(o.created_at)}</div></td>
      <td class="col-actions"><button class="btn-icon" data-order-id="${o.id}">⋯</button></td>
    </tr>
  `).join('');

  // update footer info
  if (tableRange) tableRange.textContent = `${start + 1} - ${Math.min(start + pageSize, total)}`;
  if (tableTotal) tableTotal.textContent = total;

  // render pagination
  if (paginationContainer) {
    paginationContainer.innerHTML = Array.from({ length: pages }, (_, i) => `<button class="page-btn ${i + 1 === page ? 'active' : ''}" data-page="${i + 1}">${i + 1}</button>`).join('');
    paginationContainer.querySelectorAll('.page-btn').forEach(btn => btn.addEventListener('click', () => {
      ordersTableState.page = Number(btn.dataset.page);
      renderOrdersTable(orders);
    }));
  }

  // attach row click handlers
  tbody.querySelectorAll('.orders-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = Number(row.dataset.orderId);
      ordersTableState.selectedId = id;
      const order = dashboardState.orders.find(o => Number(o.id) === id);
      if (order) showOrderDetail(order);
      // highlight selection
      tbody.querySelectorAll('.orders-row').forEach(r => r.classList.toggle('selected', Number(r.dataset.orderId) === id));
    });
  });
}

function showOrderDetail(order) {
  // Preserve the `#detailOrderId` element by updating the title as HTML
  const title = document.getElementById('detailTitle');
  if (title) title.innerHTML = `Comanda #<span id="detailOrderId">${order.id}</span>`;
  const idNode = document.getElementById('detailOrderId');
  const clientName = document.getElementById('detailClientName'); if (clientName) clientName.textContent = order.client_name || '-';
  const clientPhone = document.getElementById('detailClientPhone'); if (clientPhone) clientPhone.textContent = order.client_phone || '-';
  const address = document.getElementById('detailAddress'); if (address) address.textContent = `${order.barrio || ''} · ${order.address || ''}`;
  const breakdownSubtotal = (Array.isArray(order.items) ? order.items : []).reduce((sum, item) => {
    const unitPrice = Number(item.unitPrice ?? item.unit_price ?? 0);
    const quantity = Number(item.quantity || 1);
    return sum + (unitPrice * quantity);
  }, 0);
  const shippingValue = resolveOrderShipping(order, breakdownSubtotal);
  const breakdownTotal = breakdownSubtotal + shippingValue;
  const items = document.getElementById('detailItems'); if (items) {
    const list = (order.items || []).map(i => `<div style="display:flex;justify-content:space-between; padding:6px 0;"> <div>${escapeHtml(i.name_snapshot || i.name || 'Item')}</div><div class="subtle">x${i.quantity}</div></div>`).join('') || '<div class="subtle">Sin items</div>';
    items.innerHTML = `<div class="subtle">Resumen del pedido</div><div>${list}</div>`;
  }
  const subtotalNode = document.getElementById('detailSubtotal'); if (subtotalNode) subtotalNode.textContent = money(breakdownSubtotal);
  const shippingNode = document.getElementById('detailShipping'); if (shippingNode) shippingNode.textContent = money(shippingValue);
  const totalNode = document.getElementById('detailTotal'); if (totalNode) totalNode.textContent = money(breakdownTotal || 0);
  const statusBadge = document.getElementById('detailStatusBadge'); if (statusBadge) {
    statusBadge.textContent = (order.status || '').toUpperCase();
    // adjust classes
    const statusValue = String(order.status || '').toLowerCase();
    statusBadge.className = 'insight-chip ' + (statusValue.includes('cancel') ? 'danger' : (statusValue.includes('entreg') ? 'success' : (statusValue.includes('ruta') ? 'neutral' : '')));
  }

  // highlight the corresponding row in the table
  try {
    // remove previous selection
    document.querySelectorAll('.orders-row.selected').forEach(r => r.classList.remove('selected'));
    const row = document.querySelector(`.orders-row[data-order-id="${order.id}"]`);
    if (row) {
      row.classList.add('selected');
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (e) {
    // ignore
  }
}

function getOrderIcon(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'Nuevo') return '🟦';
  if (s === 'En preparación') return '🟨';
  if (s === 'Listo para salir') return '✅';
  if (s === 'En ruta') return '🚚';
  if (s === 'Entregado') return '📦';
  if (s === 'Cancelado') return '🚫';
  return '📍';
}

function getOrderIconClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'nuevo') return 'icon-new';
  if (s === 'en preparación') return 'icon-prep';
  if (s === 'listo para salir') return 'icon-ready';
  if (s === 'en ruta') return 'icon-route';
  if (s === 'entregado') return 'icon-delivered';
  if (s === 'cancelado') return 'icon-cancelled';
  return 'icon-new';
}

function getOrderPriorityClass(order) {
  // Business rule: high priority if payment is Transferencia or if notes contain 'urgente'
  const notes = String(order.notes || '').toLowerCase();
  if (String(order.payment_method || '').toLowerCase().includes('transfer') || notes.includes('urg')) return 'priority-high';
  // medium if payment is Nequi/Daviplata or barrio marked as 'centro'
  if (String(order.payment_method || '').toLowerCase().includes('nequi') || String(order.barrio || '').toLowerCase().includes('centro')) return 'priority-medium';
  return 'priority-low';
}

function getOrderPriorityLabel(order) {
  const cls = getOrderPriorityClass(order);
  if (cls === 'priority-high') return 'Alta';
  if (cls === 'priority-medium') return 'Media';
  return 'Baja';
}

function renderStats(stats) {
  const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const trendContainer = document.getElementById('statsTrend');
  const rankingsContainer = document.getElementById('statsRankings');
  const rangeLabels = {
    day: 'Día',
    week: 'Semana',
    month: 'Mes'
  };

  // 1. KPIs Principales
  safeSet('statsTotalOrders', stats.totalOrders);
  safeSet('statsTotalSales', money(stats.totalSales));
  safeSet('statsAverageTicket', money(stats.averageTicket));
  safeSet('statsAverageDeliveryTime', `${(stats.averageDeliveryTimeMinutes || 0).toFixed(0)} min`);
  
  const rangeText = `${rangeLabels[stats.range] || stats.range} (${stats.start} - ${stats.end})`;
  safeSet('statsPeriodRange', rangeText);

  // 2. Tasas de éxito
  const delivered = stats.deliveredOrders || 0;
  const cancelled = stats.cancelledOrders || 0;
  const total = stats.totalOrders || 1;
  safeSet('statsSuccessRate', `${Math.round((delivered / total) * 100)}%`);
  safeSet('statsDeliveredOrders', `${delivered} pedidos finalizados`);
  safeSet('statsCancelRate', `${Math.round((cancelled / total) * 100)}%`);
  safeSet('statsCancelledOrders', `${cancelled} pedidos perdidos`);

  // 3. Distribución por estados (Barras de progreso)
  const statusCounts = dashboardState.orders.reduce((accumulator, order) => {
    const key = String(order.status || 'nuevo').toLowerCase();
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  const statusRows = [
    { key: 'nuevo', label: 'Nuevos', colorClass: 'fill-0' },
    { key: 'en preparación', label: 'En preparación', colorClass: 'fill-1' },
    { key: 'listo para salir', label: 'Listos para salir', colorClass: 'fill-2' },
    { key: 'en ruta', label: 'En trayecto', colorClass: 'fill-0' },
    { key: 'entregado', label: 'Entregados', colorClass: 'fill-1' },
    { key: 'cancelado', label: 'Incidencias', colorClass: 'fill-2' }
  ];

  const maxStatusCount = Math.max(...statusRows.map((row) => statusCounts[row.key] || 0), 1);

  if (trendContainer) {
    trendContainer.innerHTML = `
      <div class="stats-trend-list">
        ${statusRows.map((row) => {
          const count = statusCounts[row.key] || 0;
          const width = `${Math.max((count / maxStatusCount) * 100, 8)}%`;
          return `
            <div class="stats-trend-row" style="margin-bottom: 8px;">
              <div class="stats-trend-label" style="font-size: 13px; font-weight: 500;">
                <span class="dot ${row.colorClass}"></span>
                <span>${row.label}</span>
              </div>
              <div class="stats-trend-track" style="height: 8px;"><div class="stats-trend-fill ${row.colorClass}" style="width:${width}"></div></div>
              <strong style="font-size: 14px;">${count}</strong>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // 4. Mejores rendimientos (Top Rankings)
  if (rankingsContainer) {
    rankingsContainer.innerHTML = `
      <div class="insight-card" style="min-height: auto; padding: 16px;">
        <div class="insight-head"><span>Producto Estrella</span><span class="insight-chip success">TOP</span></div>
        <strong style="margin: 8px 0;">${stats.topProduct}</strong>
        <div class="insight-foot"><span>${stats.topProductCount || 0} unidades vendidas</span></div>
      </div>
      <div class="insight-card" style="min-height: auto; padding: 16px;">
        <div class="insight-head"><span>Domiciliario del Periodo</span><span class="insight-chip neutral">Rendimiento</span></div>
        <strong style="margin: 8px 0;">${stats.topDriver}</strong>
        <div class="insight-foot"><span>Mayor efectividad de entrega</span></div>
      </div>
    `;
  }
}

function renderOverviewKpis() {
  const { products, drivers, orders, stats } = dashboardState;
  const activeDrivers = drivers.filter((driver) => Number(driver.active) === 1).length;
  const activeProducts = products.filter((product) => Number(product.active) === 1).length;

  document.getElementById('kpiOrders').textContent = stats ? String(stats.totalOrders) : '0';
  document.getElementById('kpiSales').textContent = stats ? money(stats.totalSales) : money(0);
  document.getElementById('kpiDrivers').textContent = String(activeDrivers);
  document.getElementById('kpiProducts').textContent = String(activeProducts);
  document.getElementById('kpiDeliveredOrders').textContent = stats ? String(stats.deliveredOrders) : '0';
  document.getElementById('kpiCancelledOrders').textContent = stats ? String(stats.cancelledOrders) : '0';
  document.getElementById('kpiAverageTicket').textContent = stats ? money(stats.averageTicket) : money(0);
  document.getElementById('kpiAverageDeliveryTime').textContent = stats ? `${(stats.averageDeliveryTimeMinutes || 0).toFixed(0)} min` : '0 min';
  document.getElementById('overviewStatusText').textContent = `${orders.length} pedidos cargados`;

  // Update comandas KPIs if present
  const safe = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  safe('ordersTodayCount', orders.length);

  // Consistencia: El conteo de "En preparación" debe incluir 'nuevo' y 'listo' como el filtro de la tabla
  const preparing = orders.filter(o => {
    const s = String(o.status || '').toLowerCase();
    return s.includes('prepar') || s.includes('nuevo') || s.includes('listo');
  }).length;

  const onRoute = orders.filter(o => String(o.status || '').toLowerCase().includes('ruta')).length;
  const delivered = orders.filter(o => String(o.status || '').toLowerCase().includes('entreg')).length;
  safe('ordersPreparing', preparing);
  safe('ordersOnRoute', onRoute);
  safe('ordersDelivered', delivered);
  const pct = (n) => orders.length ? `${Math.round((n / orders.length) * 100)}%` : '0%';
  safe('ordersPreparingPercent', pct(preparing));
  safe('ordersOnRoutePercent', pct(onRoute));
  safe('ordersDeliveredPercent', pct(delivered));
}

function renderSidebarSnapshot() {
  const activeDrivers = dashboardState.drivers.filter((driver) => Number(driver.active) === 1).length;
  const activeClients = dashboardState.clients.length;
  const totalOrders = dashboardState.orders.length;

  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  };

  setValue('sidebarOrdersCount', totalOrders);
  setValue('sidebarDriversCount', activeDrivers);
  setValue('sidebarClientsCount', activeClients);
}

function renderOrdersChart() {
  const container = document.getElementById('ordersChart');
  if (!container) return; // container may be absent in the Comanda view layout
  const statuses = [
    'nuevo',
    'en preparación',
    'listo para salir',
    'en ruta',
    'entregado',
    'cancelado'
  ];

  const counts = statuses.map((status) => dashboardState.orders.filter((order) => String(order.status || '').toLowerCase() === status).length);
  const maxCount = Math.max(...counts, 1);

  container.innerHTML = `
    <div class="chart-legend">
      ${statuses.map((status, index) => `
        <div class="chart-legend-item">
          <span class="dot dot-${index % 3}"></span>
          <span>${status}</span>
          <strong>${counts[index]}</strong>
        </div>
      `).join('')}
    </div>
    <div class="chart-bars">
      ${statuses.map((status, index) => {
    const width = `${Math.max((counts[index] / maxCount) * 100, 6)}%`;
    return `
          <div class="chart-bar-row">
            <div class="chart-bar-label">${status}</div>
            <div class="chart-track"><div class="chart-fill fill-${index % 3}" style="width:${width}"></div></div>
            <div class="chart-bar-value">${counts[index]}</div>
          </div>
        `;
  }).join('')}
    </div>
  `;
}

function getOrderStatusClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'nuevo') return 'status-new';
  if (normalized === 'en preparación') return 'status-prep';
  if (normalized === 'listo para salir') return 'status-ready';
  if (normalized === 'en ruta') return 'status-route';
  if (normalized === 'entregado') return 'status-delivered';
  if (normalized === 'cancelado') return 'status-cancelled';
  return 'status-new';
}

function renderOverviewInsights() {
  const getEl = (id) => document.getElementById(id);
  const { stats } = dashboardState;
  const clientsByPhone = dashboardState.orders.reduce((accumulator, order) => {
    const key = order.client_phone;
    if (!accumulator[key]) {
      accumulator[key] = {
        name: order.client_name,
        phone: order.client_phone,
        count: 0,
        total: 0
      };
    }
    accumulator[key].count += 1;
    accumulator[key].total += Number(order.total) || 0;
    return accumulator;
  }, {});

  const topClient = Object.values(clientsByPhone).sort((left, right) => right.count - left.count)[0] || null;
  const topDriver = dashboardState.drivers
    .filter((driver) => Number(driver.active) === 1)
    .map((driver) => ({
      name: driver.name,
      total: dashboardState.orders.filter((order) => order.driver_name === driver.name).length
    }))
    .sort((left, right) => right.total - left.total)[0] || null;

  const statusCounts = dashboardState.orders.reduce((accumulator, order) => {
    const key = String(order.status || 'nuevo').toLowerCase();
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  const topStatus = Object.entries(statusCounts).sort((left, right) => right[1] - left[1])[0] || ['nuevo', 0];

  const elTopClientName = getEl('topClientName'); if (elTopClientName) elTopClientName.textContent = topClient ? topClient.name : 'Sin datos';
  const elTopClientMeta = getEl('topClientMeta'); if (elTopClientMeta) elTopClientMeta.textContent = topClient ? `${topClient.phone} · ${topClient.count} pedidos · ${money(topClient.total)}` : 'Todavía no hay suficiente historial para calcularlo.';
  const elTopClientOrders = getEl('topClientOrders'); if (elTopClientOrders) elTopClientOrders.textContent = topClient ? `${topClient.count} pedidos` : '0 pedidos';
  const elTopClientTotal = getEl('topClientTotal'); if (elTopClientTotal) elTopClientTotal.textContent = topClient ? `${money(topClient.total)} total` : '$0 total';

  const elTopDriverName = getEl('topDriverName'); if (elTopDriverName) elTopDriverName.textContent = topDriver ? topDriver.name : 'Sin datos';
  const elTopDriverMeta = getEl('topDriverMeta'); if (elTopDriverMeta) elTopDriverMeta.textContent = topDriver ? `${topDriver.total} pedidos asignados` : 'Se actualiza con la operación diaria.';
  const elTopDriverOrders = getEl('topDriverOrders'); if (elTopDriverOrders) elTopDriverOrders.textContent = topDriver ? `${topDriver.total} pedidos` : '0 pedidos';
  const elTopDriverZone = getEl('topDriverZone'); if (elTopDriverZone) elTopDriverZone.textContent = 'Cobertura ciudad';

  const elTopProductName = getEl('topProductName'); if (elTopProductName) elTopProductName.textContent = stats ? stats.topProduct : 'Sin datos';
  const elTopProductMeta = getEl('topProductMeta'); if (elTopProductMeta) elTopProductMeta.textContent = stats && stats.topProduct !== 'Sin datos' ? `El producto más vendido en el rango.` : 'Todavía no hay suficiente historial.';
  const elTopProductCount = getEl('topProductCount'); if (elTopProductCount) elTopProductCount.textContent = stats && stats.topProduct !== 'Sin datos' ? `${stats.topProductCount || 0} unidades` : '0 unidades';

  const elTopStatusName = getEl('topStatusName'); if (elTopStatusName) elTopStatusName.textContent = topStatus[0];
  const elTopStatusMeta = getEl('topStatusMeta'); if (elTopStatusMeta) elTopStatusMeta.textContent = `${topStatus[1]} pedidos dentro del estado dominante.`;
  const elTopStatusCount = getEl('topStatusCount'); if (elTopStatusCount) elTopStatusCount.textContent = `${topStatus[1]} pedidos`;
  const elTopStatusHint = getEl('topStatusHint'); if (elTopStatusHint) elTopStatusHint.textContent = topStatus[1] > 0 ? 'Lectura rápida del día' : 'Sin actividad dominante';
}

async function healOrdersCoordinates(orders) {
  if (!window.google || !window.google.maps || !window.google.maps.Geocoder) return;
  const geocoder = new window.google.maps.Geocoder();
  for (const order of orders) {
    if (!order.latitude || !order.longitude) {
      const fullAddress = `${order.address}, ${order.barrio || ''}, Cali, Colombia`;
      try {
        const { results } = await geocoder.geocode({ address: fullAddress });
        if (results && results[0]) {
          const loc = results[0].geometry.location;
          order.latitude = loc.lat();
          order.longitude = loc.lng();
          
          // Persistir en la base de datos para no repetir el proceso
          request(`/api/orders/${order.id}/coords`, {
            method: 'PATCH',
            body: JSON.stringify({ latitude: order.latitude, longitude: order.longitude })
          }).catch(err => console.error(`Error persistiendo coordenadas del pedido #${order.id}:`, err));
        }
      } catch (e) {
      }
    }
  }
}

async function refreshDashboard() {
  const cutoffHour = document.querySelector('#statsForm [name="cutoffHour"]')?.value || 0;
  const routeDriverId = document.getElementById('routeDriverSelect')?.value || '';
  const maxPerRoute = document.getElementById('routeLimitSelect')?.value || 6;

  let products;
  try {
    products = await request('/api/products');
  } catch (err) {
    // Fallback: intentar en 127.0.0.1:55042 (puerto de desarrollo donde importamos)
    try {
      baseUrl = 'http://127.0.0.1:55042';
      console.log('refreshDashboard: switched baseUrl to', baseUrl);
      products = await request('/api/products');
    } catch (err2) {
      throw err; // rethrow original
    }
  }

  const [drivers, orders, clients, stats, zones, closures] = await Promise.all([
    request('/api/drivers'),
    request('/api/orders'),
    request('/api/clients'),
    request(`/api/stats?range=day&cutoffHour=${cutoffHour}`),
    request('/api/dangerous-zones'),
    request('/api/daily-closures')
  ]);

  LOGISTICS_CONFIG.dangerousZones = zones;

  if (window.google && window.google.maps && window.google.maps.Geocoder) {
    await healOrdersCoordinates(orders);
  }

  const routeSuggestion = await request(`/api/routes/suggest?driverId=${encodeURIComponent(routeDriverId)}&maxPerRoute=${maxPerRoute}`);

  // Curar coordenadas faltantes antes de renderizar
  if (routeSuggestion && routeSuggestion.suggestedRoutes) {
    for (const route of routeSuggestion.suggestedRoutes) {
      await healOrdersCoordinates(route.orders);
    }
  }

  dashboardState.products = products;
  dashboardState.drivers = drivers;
  dashboardState.orders = orders;
  dashboardState.clients = clients;
  dashboardState.stats = stats;
  dashboardState.routeSuggestion = routeSuggestion;
  dailyClosuresHistory = Array.isArray(closures) ? closures : [];

  // Ejecutar balanceo automático de carga
  checkDriverBalance(drivers, orders);

  renderProducts(products);
  renderDrivers(drivers);
  renderClients();

  // Renderizado centralizado: renderOrders ya utiliza el estado de búsqueda y filtros
  renderOrders(dashboardState.orders);

  renderPendingItems();
  renderStats(stats);
  renderOverviewKpis();
  renderSidebarSnapshot();
  renderOverviewInsights();
  renderOrdersChart();

  if (ordersTableState.selectedId != null) {
    const selectedOrder = dashboardState.orders.find((order) => Number(order.id) === Number(ordersTableState.selectedId));
    if (selectedOrder) {
      showOrderDetail(selectedOrder);
      const selectedRow = document.querySelector(`.orders-row[data-order-id="${selectedOrder.id}"]`);
      document.querySelectorAll('.orders-row.selected').forEach((row) => row.classList.remove('selected'));
      if (selectedRow) selectedRow.classList.add('selected');
    }
  }

  if (routeSuggestion.suggestedRoutes && dashboardState.selectedSuggestedRouteIndex >= routeSuggestion.suggestedRoutes.length) {
    dashboardState.selectedSuggestedRouteIndex = 0;
  }
  renderRoutes(routeSuggestion, drivers);
  document.getElementById('serverStatus').textContent = 'Servidor local activo';
}

function renderRoutes(routeSuggestion, drivers) {
  // Aceptar llamadas donde 'drivers' no fue pasado; usar el estado global como fallback
  if (!Array.isArray(drivers)) drivers = Array.isArray(dashboardState.drivers) ? dashboardState.drivers : [];
  const driverSelect = document.getElementById('routeDriverSelect');
  const mapContainer = document.getElementById('routeMap');
  const sequenceContainer = document.getElementById('routeSequence');
  const routesListContainer = document.getElementById('suggestedRoutesList');
  const orderCount = document.getElementById('routeOrderCount');
  const neighborhoodCount = document.getElementById('routeNeighborhoodCount');
  const distanceNode = document.getElementById('routeDistance');
  const etaNode = document.getElementById('routeEta');

  const activeDrivers = drivers.filter((driver) => Number(driver.active) === 1);

  if (driverSelect) {
    const currentValue = driverSelect.value;
    driverSelect.innerHTML = `
      <option value="">Todos los domiciliarios activos</option>
      ${activeDrivers.map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)}</option>`).join('')}
    `;
    if (currentValue) {
      driverSelect.value = currentValue;
    }
  }

  const suggestedRoutes = Array.isArray(routeSuggestion?.suggestedRoutes) ? routeSuggestion.suggestedRoutes : [];
  // Si el servidor no unificó y solo hay 1 domiciliario activo, unir rutas en el cliente como fallback
  const forceClientUnified = activeDrivers.length <= 1 && suggestedRoutes.length > 1;
  const DEPOT_LAT = 3.411568;
  const DEPOT_LON = -76.515763;
  const distanceKmClient = (lat1, lon1, lat2, lon2) => {
    const earthRadiusKm = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  let displayedRoutes = suggestedRoutes;
  if (forceClientUnified) {
    const merged = suggestedRoutes.flatMap(r => Array.isArray(r.orders) ? r.orders : []);
    const withCoords = merged.filter(o => Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude)));
    const withoutCoords = merged.filter(o => !(Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))));

    withCoords.sort((a, b) => {
      const da = distanceKmClient(DEPOT_LAT, DEPOT_LON, Number(a.latitude), Number(a.longitude));
      const db = distanceKmClient(DEPOT_LAT, DEPOT_LON, Number(b.latitude), Number(b.longitude));
      if (da !== db) return da - db;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });

    withoutCoords.sort((a, b) => {
      const na = String(a.barrio || '').localeCompare(String(b.barrio || ''));
      if (na !== 0) return na;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });

    const unifiedOrders = [...withCoords, ...withoutCoords];
    let unifiedDistance = 0;
    let unifiedEta = 0;
    for (let i = 0; i < unifiedOrders.length; i++) {
      const o = unifiedOrders[i];
      if (i === 0) {
        unifiedDistance += Number.isFinite(Number(o.distKm)) ? Number(o.distKm) : 0;
        unifiedEta += Number.isFinite(Number(o.distKm)) ? Number(o.distKm) * 3 : 0;
        continue;
      }
      const prev = unifiedOrders[i - 1];
      if (Number.isFinite(Number(prev.latitude)) && Number.isFinite(Number(prev.longitude)) && Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))) {
        const leg = distanceKmClient(Number(prev.latitude), Number(prev.longitude), Number(o.latitude), Number(o.longitude));
        unifiedDistance += leg;
        unifiedEta += leg * 3;
      } else if (Number.isFinite(Number(o.distKm))) {
        unifiedDistance += Number(o.distKm);
        unifiedEta += Number(o.distKm) * 3;
      }
    }

    displayedRoutes = [{
      id: 'route-1',
      label: 'Ruta única',
      orders: unifiedOrders,
      estimatedDistanceKm: Number(unifiedDistance).toFixed(1),
      estimatedEtaMinutes: Math.round(unifiedEta + (unifiedOrders.length * 5))
    }];
  }
  const selectedIndex = dashboardState.selectedSuggestedRouteIndex || 0;
  const currentRoute = displayedRoutes[selectedIndex] || null;
  const sequence = currentRoute ? dedupeOrdersById(currentRoute.orders) : [];

  const allOrdersReady = displayedRoutes.reduce((acc, r) => acc + (Array.isArray(r.orders) ? r.orders.length : 0), 0);
  const routeCount = displayedRoutes.length;

  if (orderCount) {
    orderCount.textContent = String(routeSuggestion?.isHistory ? sequence.length : allOrdersReady);
  }

  if (neighborhoodCount) {
    neighborhoodCount.textContent = String(routeSuggestion?.isHistory ? 1 : routeCount);
  }

  if (distanceNode) {
    // Priorizar distancias calculadas por el backend o guardadas en el historial
    const backendDistance = currentRoute?.estimatedDistanceKm || routeSuggestion?.totalDistance;
    const distanceVal = backendDistance != null 
      ? Number(backendDistance) 
      : Math.max(allOrdersReady * 1.8, routeCount * 2.4, allOrdersReady ? 2 : 0);
    
    distanceNode.textContent = `${distanceVal.toFixed(1)} KM`;
  }

  if (etaNode) {
    const backendEta = currentRoute?.estimatedEtaMinutes || routeSuggestion?.totalEta;
    const etaVal = backendEta != null
      ? Math.round(Number(backendEta))
      : Math.max(allOrdersReady * 8 + routeCount * 6, 0);
    
    etaNode.textContent = `${etaVal} MIN`;
  }

  // Ocultar acciones de asignación si estamos viendo el historial
  const assignBtn = document.getElementById('assignRouteBtn');
  const previewBtn = document.getElementById('previewOptimizeBtn');
  if (assignBtn) assignBtn.style.display = routeSuggestion?.isHistory ? 'none' : 'block';
  if (previewBtn) previewBtn.style.display = routeSuggestion?.isHistory ? 'none' : 'block';

  // Renderizar tarjetas de rutas sugeridas
  if (routesListContainer) {
    routesListContainer.innerHTML = displayedRoutes.length
      ? displayedRoutes.map((route, idx) => {
        const routeOrders = dedupeOrdersById(route.orders);
        return `
        <div class="insight-card ${idx === selectedIndex ? 'selected-route' : ''}" 
             style="padding: 12px; cursor: pointer; border: 1px solid ${idx === selectedIndex ? 'var(--accent)' : 'var(--panel-border)'}; 
                    background: ${idx === selectedIndex ? 'rgba(245,158,11,0.05)' : 'rgba(0,0,0,0.15)'}; min-height: auto;"
             data-route-idx="${idx}"> 
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size: 14px; margin: 0;">${escapeHtml(route.label || `Ruta ${idx + 1}`)}</strong>
            <span class="insight-chip success" style="font-size: 10px;">${routeOrders.length} pedidos</span>
          </div>
          <p style="font-size: 11px; margin-top: 4px;">Ruta #${idx + 1}</p>
        </div>
      `;
      }).join('')
      : '<div class="subtle">No hay rutas disponibles.</div>';

    routesListContainer.querySelectorAll('[data-route-idx]').forEach(card => {
      card.addEventListener('click', () => {
        dashboardState.selectedSuggestedRouteIndex = Number(card.dataset.routeIdx);
        dashboardState.routeOptimization = null; // Resetear optimización previa al cambiar
        renderRoutes(routeSuggestion, drivers);
      });
    });
  }

  if (sequenceContainer) {
    const title = sequenceContainer.previousElementSibling;
    if (title && title.tagName === 'H3' && currentRoute) {
      title.innerHTML = `Secuencia: <span style="color:var(--accent)">${escapeHtml(currentRoute.label || `Ruta ${selectedIndex + 1}`)}</span>`;
    }
    sequenceContainer.innerHTML = sequence.length
      ? sequence.map((order, index) => `
        <article class="route-stop" style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); border-radius: 14px; padding: 16px; transition: all 0.2s ease; display: flex; gap: 16px; align-items: flex-start;">
          <div class="route-stop-index" style="width: 32px; height: 32px; border-radius: 8px; background: ${index === 0 ? 'var(--accent)' : 'rgba(255,255,255,0.05)'}; color: ${index === 0 ? 'var(--bg-bottom)' : 'var(--text-primary)'}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; flex-shrink: 0;">${index + 1}</div>
          <div class="route-stop-body">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <strong style="font-size: 14px; font-weight: 700; letter-spacing: -0.01em;">${escapeHtml(order.client_name || `Pedido #${order.id}`)}</strong>
              <span class="order-status-badge ${getOrderStatusClass(order.status)}" style="font-size: 9px; padding: 2px 8px;">${order.status}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin: 4px 0;">${escapeHtml(order.address || 'Sin dirección')}</div>
            <div style="display: flex; gap: 8px; align-items: center; margin-top: 8px;">
              <span style="font-size: 11px; font-weight: 700; color: var(--accent);">${money(order.total)}</span>
              <span style="width: 4px; height: 4px; border-radius: 50%; background: var(--panel-border);"></span>
              <span class="subtle" style="font-size: 11px;">${escapeHtml(order.barrio || 'Sin barrio')}</span>
            </div>

            ${Number.isFinite(Number(order.segmentDistanceKm)) || Number.isFinite(Number(order.segmentDurationMin)) || Number.isFinite(Number(order.cumulativeDistanceKm)) || Number.isFinite(Number(order.etaMinutes))
          ? `<div class="route-stop-metrics" style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
                  ${Number.isFinite(Number(order.segmentDistanceKm)) ? `<span style="background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 6px; font-size: 10px; color: var(--muted); border: 1px solid var(--panel-border);">+${Number(order.segmentDistanceKm).toFixed(1)} km</span>` : ''}
                  ${Number.isFinite(Number(order.etaMinutes)) ? `<span style="background: rgba(34, 197, 94, 0.1); padding: 4px 8px; border-radius: 6px; font-size: 10px; color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2);">ETA: ${Math.round(Number(order.etaMinutes))} min</span>` : ''}
                </div>`
          : ''}
          </div>
        </article>
      `).join('')
      : '<div class="product-group-empty">No hay pedidos listos para enrutar.</div>';
  }

  if (!mapContainer) return;

  // Si Google Maps está cargado y dispone del constructor Map, delegar el render a Google
  if (window.google && window.google.maps && typeof window.google.maps.Map === 'function') {
    try {
      renderRoutesGoogle(routeSuggestion);
    } catch (err) {
      console.error('Error rendering with Google Maps:', err);
    }
    return;
  }

  if (typeof window.L === 'undefined') return;
  const mapEl = document.getElementById('routeMap');
  if (!mapEl) return;

  // If the container is not visible yet, Leaflet may throw when accessing sizes.
  // Retry shortly instead of initializing immediately.
  if (mapEl.offsetWidth === 0 || mapEl.offsetHeight === 0) {
    setTimeout(() => renderRoutes(dashboardState.routeSuggestion), 150);
    return;
  }

  if (!routeMapInstance) {
    routeMapInstance = window.L.map('routeMap', { zoomControl: true }).setView([3.411568, -76.515763], 14);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19
    }).addTo(routeMapInstance);
    routeLayerGroup = window.L.layerGroup().addTo(routeMapInstance);
    // Ensure Leaflet computes sizes correctly after being inserted

    // Inicializar Leaflet.draw
    drawnItems = new window.L.FeatureGroup();
    routeMapInstance.addLayer(drawnItems);
    const drawControl = new window.L.Control.Draw({
      edit: {
        featureGroup: drawnItems
      },
      draw: {
        polygon: true,
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false
      }
    });
    routeMapInstance.addControl(drawControl);

    routeMapInstance.on(window.L.Draw.Event.CREATED, function (event) {
      const layer = event.layer;
      if (layer instanceof window.L.Polygon) {
        const coords = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
        const newZone = {
          name: `Nueva Zona ${Date.now().toString().slice(-4)}`,
          riskScore: 5,
          color: "#ef4444",
          polygon: coords
        };
        request('/api/dangerous-zones', { method: 'POST', body: JSON.stringify(newZone) })
          .then(() => {
            showToast('Zona guardada en el servidor', 'success');
            refreshDashboard();
          });
        drawnItems.addLayer(layer);
      }
    });

    routeMapInstance.on(window.L.Draw.Event.EDITED, function (event) {
      event.layers.eachLayer(function (layer) {
        if (layer instanceof window.L.Polygon) {
          const coords = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
          const index = LOGISTICS_CONFIG.dangerousZones.findIndex(z => JSON.stringify(z.polygon) === JSON.stringify(layer._leaflet_id)); // Esto no es ideal, mejor usar un ID único
          if (index !== -1) {
            LOGISTICS_CONFIG.dangerousZones[index].polygon = coords;
            localStorage.setItem('dangerousZones', JSON.stringify(LOGISTICS_CONFIG.dangerousZones));
            showToast('Zona peligrosa actualizada.', 'success');
          }
        }
      });
    });

    routeMapInstance.on(window.L.Draw.Event.DELETED, function (event) {
      event.layers.eachLayer(function (layer) {
        if (layer instanceof window.L.Polygon) {
          // Eliminar de LOGISTICS_CONFIG.dangerousZones
          LOGISTICS_CONFIG.dangerousZones = LOGISTICS_CONFIG.dangerousZones.filter(z => JSON.stringify(z.polygon) !== JSON.stringify(layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng])));
          localStorage.setItem('dangerousZones', JSON.stringify(LOGISTICS_CONFIG.dangerousZones));
          showToast('Zona peligrosa eliminada.', 'info');
        }
      });
    });

    setTimeout(() => { try { routeMapInstance.invalidateSize(); } catch (e) {} }, 200);
  } else {
    try { routeMapInstance.invalidateSize(); } catch (e) { /* ignore */ }
  }

  routeLayerGroup.clearLayers();
  if (drawnItems) drawnItems.clearLayers(); // Limpiar capas de dibujo para evitar duplicados

    // 1. Renderizar Zonas Peligrosas
  LOGISTICS_CONFIG.dangerousZones.forEach(zone => {
    window.L.polygon(zone.polygon, {
      color: zone.color,
      fillColor: zone.color,
      fillOpacity: 0.2,
      weight: 2
    }).addTo(routeLayerGroup).bindPopup(`⚠️ ${zone.name} (Riesgo: ${zone.riskScore})`).on('click', (e) => {
      // Permitir edición al hacer clic en el polígono
      if (drawnItems) drawnItems.addLayer(e.target);
    });
  });

  // 2. Renderizar Heatmap de Pedidos Activos
  const heatPoints = dashboardState.orders
    .filter(o => o.latitude && o.status === 'nuevo')
    .map(o => [o.latitude, o.longitude, 0.5]); // lat, lng, intensidad

  if (heatPoints.length > 0) {
    window.L.heatLayer(heatPoints, {
      radius: 25,
      blur: 15,
      maxZoom: 17,
      gradient: {0.4: 'blue', 0.65: 'lime', 1: 'red'}
    }).addTo(routeLayerGroup);
  }

  // Debug: clear any existing debug markers in Leaflet
  if (routeMapInstance.debugLayer) {
    try { routeMapInstance.removeLayer(routeMapInstance.debugLayer); } catch (e) {}
    routeMapInstance.debugLayer = null;
  }

  try {
    if (!sequence.length) {
      window.L.marker([3.411568, -76.515763]).addTo(routeLayerGroup).bindPopup('SISPED SW · Sede República de Israel');
      routeMapInstance.setView([3.411568, -76.515763], 14);
      return;
    }

    const routePoints = sequence.map((order, index) => ({
      order,
      coordinates: getRouteCoordinate(order, index)
    }));

    const polylinePoints = routePoints.map((point) => point.coordinates);
    // Filtrar puntos inválidos
    const validRoutePoints = routePoints.filter(p => Array.isArray(p.coordinates) && p.coordinates.length === 2 && Number.isFinite(p.coordinates[0]) && Number.isFinite(p.coordinates[1]));

    // DEBUG: mostrar coordenadas que se usarán para pintar marcadores
    try {
      console.log('Route valid points:', validRoutePoints.map(p => ({ id: p.order.id, address: p.order.address, coords: p.coordinates })));
    } catch (e) { /* ignore debug errors */ }

    validRoutePoints.forEach((point, index) => {
      try {
        const html = `<div class="order-marker-badge">${index + 1}</div>`;
        const icon = window.L.divIcon({ html, className: 'order-marker-divicon', iconSize: [36, 36], iconAnchor: [18, 18] });
        const lm = window.L.marker(point.coordinates, { icon }).addTo(routeLayerGroup).bindPopup(`
          <strong>${escapeHtml(point.order.client_name || `Pedido #${point.order.id}`)}</strong><br />
          ${escapeHtml(point.order.barrio || 'Sin barrio')}<br />
          ${escapeHtml(point.order.address || 'Sin dirección')}
        `);
        // debug
        try {
          const latlng = lm.getLatLng();
          const el = lm.getElement && lm.getElement();
          const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          console.log('Leaflet marker created', { id: point.order.id, latlng, rect });
        } catch (le) { console.warn('Leaflet debug failed', le); }
      } catch (e) {
        // fallback to circleMarker if divIcon fails
        window.L.circleMarker(point.coordinates, {
          radius: 10,
          color: index === 0 ? '#f59e0b' : '#60a5fa',
          fillColor: index === 0 ? '#f97316' : '#3b82f6',
          fillOpacity: 0.9,
          weight: 2
        }).addTo(routeLayerGroup).bindPopup(`
          <strong>${escapeHtml(point.order.client_name || `Pedido #${point.order.id}`)}</strong><br />
          ${escapeHtml(point.order.barrio || 'Sin barrio')}<br />
          ${escapeHtml(point.order.address || 'Sin dirección')}
        `);
      }
    });

    // Add Leaflet debug markers layer (small purple markers) and DOM crosses for pixel position
    try {
      const debugGroup = window.L.layerGroup();
      validRoutePoints.forEach((point) => {
        const debugIcon = window.L.divIcon({ className: 'leaflet-debug-marker', iconSize: [10,10] });
        window.L.marker(point.coordinates, { icon: debugIcon, interactive: false }).addTo(debugGroup);
      });
      debugGroup.addTo(routeMapInstance);
      routeMapInstance.debugLayer = debugGroup;
    } catch (e) { /* ignore debug marker errors */ }

    if (validRoutePoints.length) {
      const polylinePointsValid = validRoutePoints.map(p => p.coordinates);
      const boundsPoints = [[3.411568, -76.515763], ...polylinePointsValid];
      // Si la sugerencia incluye una geometría (GeoJSON) preferirla
      if (routeSuggestion && routeSuggestion.geometry && routeSuggestion.geometry.coordinates) {
        try {
          const geo = window.L.geoJSON(routeSuggestion.geometry, { style: { color: '#f59e0b', weight: 4, opacity: 0.8 } }).addTo(routeLayerGroup);
          routeMapInstance.fitBounds(boundsPoints, { padding: [30, 30] });
        } catch (e) {
          window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);
          routeMapInstance.fitBounds(boundsPoints, { padding: [30, 30] });
        }
      } else {
        window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);
        try { routeMapInstance.fitBounds(boundsPoints, { padding: [30, 30] }); } catch (e) { console.error('fitBounds failed', e); }
      }
    } else {
      // No hay puntos válidos, centrar en la ciudad
      routeMapInstance.setView([3.411568, -76.515763], 14);
    }
  } catch (err) {
    console.error('Error rendering Leaflet routes:', err);
    try { routeMapInstance.setView([3.4516, -76.5320], 12); } catch (e) { /* ignore */ }
  }
}

/**
 * Abre un modal para editar metadatos de las zonas peligrosas
 */
function openDangerousZonesModal() {
  const zones = LOGISTICS_CONFIG.dangerousZones;
  
  const body = `
    <div class="panel" style="background: rgba(0,0,0,0.1); padding: 12px; border-radius: 12px;">
      <p class="subtle" style="margin-bottom: 12px;">Ajusta el nombre, nivel de riesgo y color de las zonas marcadas en el mapa.</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="text-align: left; color: var(--muted); border-bottom: 1px solid var(--panel-border);">
            <th style="padding: 10px;">Nombre</th>
            <th style="padding: 10px;">Riesgo (1-10)</th>
            <th style="padding: 10px;">Color</th>
            <th style="padding: 10px;">Acción</th>
          </tr>
        </thead>
        <tbody id="zonesManagementList">
          ${zones.map((zone, idx) => `
            <tr data-zone-idx="${idx}" style="border-bottom: 1px solid var(--panel-border);">
              <td style="padding: 10px;"><input type="text" class="zone-name" value="${escapeHtml(zone.name)}" style="width: 100%; padding: 6px; border-radius: 6px;" /></td>
              <td style="padding: 10px;"><input type="number" class="zone-risk" value="${zone.riskScore}" min="1" max="10" style="width: 70px; padding: 6px; border-radius: 6px;" /></td>
              <td style="padding: 10px;"><input type="color" class="zone-color" value="${zone.color}" style="width: 44px; height: 32px; padding: 2px; border: none; border-radius: 4px; cursor: pointer; background: transparent;" /></td>
              <td style="padding: 10px;"><button class="mini-action danger delete-zone">Eliminar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${zones.length === 0 ? '<p class="subtle" style="text-align: center; padding: 30px;">No hay zonas definidas en el mapa.</p>' : ''}
    </div>
  `;

  showModal({
    title: 'Gestión de Zonas de Riesgo',
    body,
    confirmText: 'Aplicar y Cerrar',
    cancelText: null,
    onConfirm: () => {
      renderRoutes(dashboardState.routeSuggestion, dashboardState.drivers);
    }
  });

  const list = document.getElementById('zonesManagementList');
  if (!list) return;

  const syncZones = () => {
    const rows = list.querySelectorAll('tr');
    const newZones = [];
    rows.forEach(row => {
      const idx = row.dataset.zoneIdx;
      const original = LOGISTICS_CONFIG.dangerousZones[idx];
      newZones.push({
        ...original,
        name: row.querySelector('.zone-name').value,
        riskScore: Number(row.querySelector('.zone-risk').value),
        color: row.querySelector('.zone-color').value
      });
    });
    LOGISTICS_CONFIG.dangerousZones = newZones;
    localStorage.setItem('dangerousZones', JSON.stringify(newZones));
  };

  list.addEventListener('input', syncZones);
  list.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete-zone')) {
      const row = e.target.closest('tr');
      row.remove();
      syncZones();
    }
  });
}

// --- Google Maps helpers ---
function loadGoogleMapsSdk(apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error('API key vacía'));
    if (window.google && window.google.maps) return resolve(window.google.maps);
    
    // Definir callback global para el nuevo sistema de carga
    window.onGoogleMapsInit = () => resolve(window.google.maps);

    const scriptId = 'google-maps-sdk';
    if (document.getElementById(scriptId)) {
      const check = setInterval(() => {
        if (window.google && window.google.maps) {
          clearInterval(check);
          resolve(window.google.maps);
        }
      }, 200);
      setTimeout(() => { clearInterval(check); reject(new Error('Timeout cargando Google Maps')); }, 10000);
      return;
    }
    const s = document.createElement('script');
    s.id = scriptId;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places,marker&loading=async&callback=onGoogleMapsInit`;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (window.google && window.google.maps) resolve(window.google.maps);
      else reject(new Error('SDK cargado pero google.maps no disponible'));
    };
    s.onerror = () => reject(new Error('Error cargando Google Maps SDK'));
    document.head.appendChild(s);
  });
}

function renderRoutesGoogle(routeSuggestion) {
  const mapEl = document.getElementById('routeMap');
  if (!mapEl || !window.google || !window.google.maps) return;

  if (!googleMapInstance) {
    googleMapInstance = new window.google.maps.Map(mapEl, {
      center: { lat: 3.411568, lng: -76.515763 },
      zoom: 12,
      mapId: 'DEMO_MAP_ID'
    });
  }

  // limpiar previos
  googleMarkers.forEach(m => m.setMap(null));
  googleMarkers = [];
  // limpiar debug markers
  googleDebugMarkers.forEach(m => m.setMap && m.setMap(null));
  googleDebugMarkers = [];
  googleDebugOverlays.forEach(o => o.setMap && o.setMap(null));
  googleDebugOverlays = [];
  if (googlePolyline) { googlePolyline.setMap(null); googlePolyline = null; }

  const suggestedRoutes = Array.isArray(routeSuggestion?.suggestedRoutes) ? routeSuggestion.suggestedRoutes : [];
  const activeDrivers = Array.isArray(dashboardState.drivers) ? dashboardState.drivers.filter((d) => Number(d.active) === 1) : [];
  const forceClientUnified = activeDrivers.length <= 1 && suggestedRoutes.length > 1;
  let displayedRoutes = suggestedRoutes;
  if (forceClientUnified) {
    const merged = suggestedRoutes.flatMap(r => Array.isArray(r.orders) ? r.orders : []);
    const DEPOT_LAT = 3.411568;
    const DEPOT_LON = -76.515763;
    const distanceKmClient = (lat1, lon1, lat2, lon2) => {
      const earthRadiusKm = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const withCoords = merged.filter(o => Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude)));
    const withoutCoords = merged.filter(o => !(Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))));
    withCoords.sort((a, b) => {
      const da = distanceKmClient(DEPOT_LAT, DEPOT_LON, Number(a.latitude), Number(a.longitude));
      const db = distanceKmClient(DEPOT_LAT, DEPOT_LON, Number(b.latitude), Number(b.longitude));
      if (da !== db) return da - db;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });
    withoutCoords.sort((a, b) => {
      const na = String(a.barrio || '').localeCompare(String(b.barrio || ''));
      if (na !== 0) return na;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });
    const unifiedOrders = [...withCoords, ...withoutCoords];
    let unifiedDistance = 0;
    let unifiedEta = 0;
    for (let i = 0; i < unifiedOrders.length; i++) {
      const o = unifiedOrders[i];
      if (i === 0) {
        unifiedDistance += Number.isFinite(Number(o.distKm)) ? Number(o.distKm) : 0;
        unifiedEta += Number.isFinite(Number(o.distKm)) ? Number(o.distKm) * 3 : 0;
        continue;
      }
      const prev = unifiedOrders[i - 1];
      if (Number.isFinite(Number(prev.latitude)) && Number.isFinite(Number(prev.longitude)) && Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))) {
        const leg = distanceKmClient(Number(prev.latitude), Number(prev.longitude), Number(o.latitude), Number(o.longitude));
        unifiedDistance += leg;
        unifiedEta += leg * 3;
      } else if (Number.isFinite(Number(o.distKm))) {
        unifiedDistance += Number(o.distKm);
        unifiedEta += Number(o.distKm) * 3;
      }
    }
    displayedRoutes = [{ id: 'route-1', label: 'Ruta única', orders: unifiedOrders, estimatedDistanceKm: Number(unifiedDistance).toFixed(1), estimatedEtaMinutes: Math.round(unifiedEta + (unifiedOrders.length * 5)) }];
  }
  const selectedIndex = dashboardState.selectedSuggestedRouteIndex || 0;
  const currentRoute = displayedRoutes[selectedIndex] || null;
  const sequence = currentRoute ? currentRoute.orders : (Array.isArray(routeSuggestion?.sequence) ? routeSuggestion.sequence : []);

  const points = sequence.map((order, idx) => ({ order, coord: getRouteCoordinate(order, idx) }))
    .filter(p => Array.isArray(p.coord) && p.coord.length === 2 && Number.isFinite(p.coord[0]));

  // DEBUG: inspect points used for Google Maps rendering
  try {
  } catch (e) { /* ignore */ }

  if (!points.length) {
    googleMapInstance.setCenter({ lat: 3.411568, lng: -76.515763 });
    googleMapInstance.setZoom(12);
    return;
  }

  // If a geometry is provided in routeSuggestion, use it for the polyline path
  let path;
  if (routeSuggestion && routeSuggestion.geometry && Array.isArray(routeSuggestion.geometry.coordinates) && routeSuggestion.geometry.coordinates.length) {
    path = routeSuggestion.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
  } else {
    path = points.map(p => ({ lat: p.coord[0], lng: p.coord[1] }));
  }

  // Marcador fijo del restaurante
  const restaurantPos = { lat: 3.411568, lng: -76.515763 };
  if (window.google.maps.marker && window.google.maps.marker.AdvancedMarkerElement) {
    const restaurantIcon = document.createElement('div');
    restaurantIcon.innerHTML = '🏮';
    restaurantIcon.style.fontSize = '24px';
    const restaurantMarker = new window.google.maps.marker.AdvancedMarkerElement({
      position: restaurantPos,
      map: googleMapInstance,
      title: 'SISPED SW (Sede)',
      content: restaurantIcon
    });
    googleMarkers.push(restaurantMarker);
  } else {
    const restaurantMarker = new window.google.maps.Marker({
      position: restaurantPos,
      map: googleMapInstance,
      title: 'SISPED SW'
    });
    googleMarkers.push(restaurantMarker);
  }

  points.forEach((p, i) => {
    const position = { lat: p.coord[0], lng: p.coord[1] };
    const info = new window.google.maps.InfoWindow({ content: `<strong>${escapeHtml(p.order.client_name || `Pedido #${p.order.id}`)}</strong><br/>${escapeHtml(p.order.barrio || '')}` });
    
    try {
      if (window.google.maps.marker && window.google.maps.marker.AdvancedMarkerElement) {
        const contentEl = document.createElement('div');
        contentEl.className = 'order-marker-badge';
        contentEl.textContent = `${i + 1}`;
        
        const adv = new window.google.maps.marker.AdvancedMarkerElement({
          position,
          map: googleMapInstance,
          title: p.order.client_name || `Pedido #${p.order.id}`,
          content: contentEl
        });
        
        adv.addListener('gmp-click', () => info.open({ anchor: adv, map: googleMapInstance }));
        googleMarkers.push(adv);
      } else {
        const marker = new window.google.maps.Marker({ position, map: googleMapInstance });
        marker.addListener('click', () => info.open(googleMapInstance, marker));
        googleMarkers.push(marker);
      }
    } catch (e) {
    }
  });

  googlePolyline = new window.google.maps.Polyline({ path, strokeColor: '#f59e0b', strokeWeight: 4, map: googleMapInstance });

  const bounds = new window.google.maps.LatLngBounds();
  bounds.extend(restaurantPos); // Siempre incluir el local
  path.forEach(p => bounds.extend(p));
  googleMapInstance.fitBounds(bounds);
}

function hideSplashScreen() {
  const splash = document.getElementById('splashScreen');
  if (!splash || splash.classList.contains('splash-hidden')) return;
  splash.classList.add('splash-hidden');
  setTimeout(() => {
    if (splash.parentNode) splash.parentNode.removeChild(splash);
  }, 500);
}

function populateSampleOverview() {
  // Datos de ejemplo para mostrar la maqueta cuando no hay backend disponible
  dashboardState.products = [{ id: 1, name: 'Arroz Chaufa', active: 1 }, { id: 2, name: 'Pollo Teriyaki', active: 1 }];
  dashboardState.drivers = [{ id: 1, name: 'Carlos', active: 1, zone: 'Centro' }];
  dashboardState.orders = [
    { id: 101, client_name: 'María López', client_phone: '3010000000', barrio: 'Granada', address: 'Cll 10 # 20', total: 12000, status: 'nuevo', created_at: new Date().toISOString() },
    { id: 102, client_name: 'Juan Pérez', client_phone: '3101112222', barrio: 'Centro', address: 'Cra 5 # 30', total: 26000, status: 'en ruta', created_at: new Date().toISOString() }
  ];
  dashboardState.stats = {
    range: 'day',
    totalOrders: 2,
    totalSales: 38000,
    deliveredOrders: 0,
    cancelledOrders: 0,
    averageTicket: 19000,
    averageDeliveryTimeMinutes: 18,
    topProduct: 'Arroz Chaufa',
    topProductCount: 3,
    topDriver: 'Carlos'
  };

  renderProducts(dashboardState.products);
  renderDrivers(dashboardState.drivers);
  renderOrders(dashboardState.orders);
  renderPendingItems();
  renderStats(dashboardState.stats);
  renderOverviewKpis();
  renderOverviewInsights();
  renderOrdersChart();
  renderDailyClosures();
}

function renderDailyClosures() {
  const tbody = document.getElementById('dailyClosuresList');
  if (!tbody) return;

  const searchTerm = String(document.getElementById('dailyClosuresSearchInput')?.value || '').toLowerCase().trim();
  const filtered = (dailyClosuresHistory || []).filter((closure) => {
    const haystack = [
      closure.day_key,
      closure.top_product,
      closure.top_driver,
      JSON.stringify(closure.snapshot || {})
    ].join(' ').toLowerCase();
    return !searchTerm || haystack.includes(searchTerm);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="subtle" style="text-align:center; padding:16px;">No hay cierres diarios para mostrar.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((closure) => `
    <tr class="orders-row" data-closure-day="${escapeHtml(closure.day_key)}" style="cursor: pointer;">
      <td style="padding: 12px 16px;">${escapeHtml(closure.day_key)}</td>
      <td style="padding: 12px 16px;">${Number(closure.total_orders || 0)} pedidos</td>
      <td style="padding: 12px 16px;">${money(closure.total_sales)}</td>
      <td style="padding: 12px 16px;">${escapeHtml(closure.top_product || 'Sin datos')}</td>
      <td style="padding: 12px 16px;">${escapeHtml(closure.top_driver || 'Sin datos')}</td>
      <td style="padding: 12px 16px; text-align:center;"><button type="button" class="btn-icon view-daily-closure" data-closure-day="${escapeHtml(closure.day_key)}">⋯</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.orders-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('.view-daily-closure')) return;
      const dayKey = row.dataset.closureDay;
      const closure = dailyClosuresHistory.find((item) => String(item.day_key) === String(dayKey));
      if (closure) showDailyClosureDetails(closure);
    });
  });

  tbody.querySelectorAll('.view-daily-closure').forEach((button) => {
    button.addEventListener('click', () => {
      const dayKey = button.dataset.closureDay;
      const closure = dailyClosuresHistory.find((item) => String(item.day_key) === String(dayKey));
      if (closure) showDailyClosureDetails(closure);
    });
  });
}

function showDailyClosureDetails(closure) {
  const snapshot = closure.snapshot || {};
  showModal({
    title: `Cierre diario ${closure.day_key}`,
    body: `
      <div class="stack-form" style="gap:12px;">
        <div><strong>Pedidos:</strong> ${Number(snapshot.totalOrders || closure.total_orders || 0)}</div>
        <div><strong>Ventas:</strong> ${money(snapshot.totalSales || closure.total_sales || 0)}</div>
        <div><strong>Entregados:</strong> ${Number(snapshot.deliveredOrders || closure.delivered_orders || 0)}</div>
        <div><strong>Cancelados:</strong> ${Number(snapshot.cancelledOrders || closure.cancelled_orders || 0)}</div>
        <div><strong>Top producto:</strong> ${escapeHtml(snapshot.topProduct || closure.top_product || 'Sin datos')}</div>
        <div><strong>Top domiciliario:</strong> ${escapeHtml(snapshot.topDriver || closure.top_driver || 'Sin datos')}</div>
        <div><strong>Ticket promedio:</strong> ${money(snapshot.averageTicket || closure.average_ticket || 0)}</div>
      </div>
    `,
    confirmText: 'Cerrar',
    cancelText: null,
    isWide: false
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireSidebarNavigation();
  scheduleMidnightRefresh();

  // Intentar cargar datos reales; en caso de error, usar muestra para la maqueta
  (async () => {
    await loadGeneratedCaliNeighborhoodCenters();
    await refreshDashboard();
  })().catch((err) => {
    console.warn('No se pudo cargar datos del backend, intentando fallback de productos.', err);
    (async () => {
      try {
        const alt = 'http://127.0.0.1:55042';
        const resp = await fetch(`${alt}/api/products`);
        if (resp.ok) {
          const products = await resp.json();
          dashboardState.products = products;
          renderProducts(products);
          showToast('Productos cargados desde fallback local', 'success');
          return;
        }
      } catch (e) {
        console.warn('Fallback de productos falló', e);
      }

      console.warn('Usando datos de ejemplo local.');
      populateSampleOverview();
    })();
  }).finally(() => {
    // Attach handlers that require DOM + data
    attachDetailUpdateHandler();
    attachOrderDetailActions();
    // Setup modal opener para crear orders
    setupOrderModalOpener();
    hideSplashScreen();
  });

  // Material Icons font is loaded; no runtime replace needed
  setTimeout(hideSplashScreen, 5500);
});

// Handle updating order status from the detail panel
async function updateOrderStatusRequest(orderId, newStatus, options = {}) {
  try {
    // Try backend first
    await request(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus, ...options })
    });
    await refreshDashboard();
    showToast('Estado actualizado', 'success');
  } catch (err) {
    // If backend not available (sample mode), update local state
    const order = dashboardState.orders.find(o => Number(o.id) === Number(orderId));
    if (order) {
      order.status = newStatus;
      showToast('Estado actualizado (modo local)', 'success');
      renderOrders(dashboardState.orders);
      showOrderDetail(order);
    }
  }
}

function attachOrderDetailActions() {
  const editBtn = document.getElementById('detailEditBtn');
  const deleteBtn = document.getElementById('detailDeleteBtn');

  if (editBtn) editBtn.addEventListener('click', () => {
    const idNode = document.getElementById('detailOrderId');
    const orderId = idNode ? Number(idNode.textContent) : null;
    const order = dashboardState.orders.find(o => o.id === orderId);
    if (order) openOrderModal(order);
  });

  if (deleteBtn) deleteBtn.addEventListener('click', () => {
    const idNode = document.getElementById('detailOrderId');
    const orderId = idNode ? Number(idNode.textContent) : null;
    if (!orderId) return;

    showModal({
      title: '¿Eliminar comanda?',
      body: `¿Estás seguro de eliminar la comanda #${orderId}? Esta acción no se puede deshacer.`,
      confirmText: 'Eliminar',
      onConfirm: async () => {
        try {
          await request(`/api/orders/${orderId}`, { method: 'DELETE' });
          showToast('Comanda eliminada', 'success');
          await refreshDashboard();
        } catch (e) { showToast(e.message, 'error'); }
      }
    });
  });
}

function attachDetailUpdateHandler() {
  const btn = document.getElementById('detailUpdateBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const idNode = document.getElementById('detailOrderId');
    const orderId = idNode ? idNode.textContent : null;
    if (!orderId || orderId === '-') {
      showToast('Selecciona una comanda primero.', 'error');
      return;
    }

    showModal({
      title: 'Actualizar estado',
      body: `
        <div style="display:grid; gap:12px;">
          <div style="font-size:12px; color: var(--muted); line-height:1.4;">Selecciona el nuevo estado de la comanda. Si la cancelas, te pediremos el motivo.</div>
          <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px;">
            <button type="button" data-new-status="nuevo" class="btn-secondary">Nuevo</button>
            <button type="button" data-new-status="en preparación" class="btn-secondary">En preparación</button>
            <button type="button" data-new-status="listo para salir" class="btn-secondary">Listo para salir</button>
            <button type="button" data-new-status="en ruta" class="btn-secondary">En ruta</button>
            <button type="button" data-new-status="entregado" class="btn-secondary">Entregado</button>
            <button type="button" data-new-status="cancelado" class="btn-danger">Cancelado</button>
          </div>
        </div>
      `,
      confirmText: null,
      cancelText: 'Cerrar',
      onConfirm: null,
      isWide: false
    });

    // Attach handlers to the buttons inside modal
    queueMicrotask(() => {
      const overlay = document.getElementById('modalOverlay');
      overlay.querySelectorAll('button[data-new-status]').forEach(b => {
        b.addEventListener('click', () => {
          const newStatus = b.dataset.newStatus;
          if (newStatus === 'cancelado') {
            closeModals();
            openCancelOrderModal(orderId);
            return;
          }
          closeModals();
          updateOrderStatusRequest(orderId, newStatus);
        });
      });
    });
  });
}

function openCancelOrderModal(orderId) {
  showModal({
    title: 'Cancelar comanda',
    body: `
      <div style="display:grid; gap:10px;">
        <div style="font-size:12px; color: var(--muted); line-height:1.4;">Escribe un motivo para dejar registro interno.</div>
        <textarea id="cancelReasonInput" rows="4" placeholder="Ej. Cliente no responde, dirección incorrecta..." style="width:100%; resize:vertical; border-radius:12px; border:1px solid var(--panel-border); background: rgba(0,0,0,0.2); color: var(--text-primary); padding:12px;"></textarea>
      </div>
    `,
    confirmText: 'Cancelar comanda',
    cancelText: 'Volver',
    onConfirm: async () => {
      const reasonInput = document.getElementById('cancelReasonInput');
      const reason = String(reasonInput?.value || '').trim();
      if (!reason) {
        showToast('Escribe un motivo de cancelación.', 'error');
        return false;
      }
      await updateOrderStatusRequest(orderId, 'cancelado', { cancelledReason: reason });
    }
  });
}

// (handler se adjunta después de cargar datos en DOMContentLoaded)

function getFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateAddressFormat(addressData = {}) {
  const address = String(addressData.address || '').trim();
  const barrio = String(addressData.barrio || '').trim();
  const label = String(addressData.label || '').trim();
  const errors = [];

  if (!address) errors.push('La dirección es obligatoria');
  if (!barrio) errors.push('El barrio es obligatorio');
  if (label && label.length > 60) errors.push('La etiqueta de dirección es demasiado larga');

  return {
    isValid: errors.length === 0,
    errors,
    errorMessage: errors.join(' | ')
  };
}

async function geocodeClientAddress(formOrData) {
  const form = formOrData?.querySelector ? formOrData : null;
  if (!form) return null;
  return resolveOrderLocation(form);
}

function attachClientAddressAutoGeocoding(container) {
  const form = container?.querySelector ? container.querySelector('#clientForm') : null;
  if (!form) return;

  const addressInput = form.querySelector('[name="address"]');
  const geocodingField = form.querySelector('[name="geocodingSource"]');
  if (!addressInput) return;

  let debounceTimer = null;
  const runGeocoding = async () => {
    const address = String(addressInput.value || '').trim();
    if (address.length < 6) return;

    try {
      const resolved = await geocodeClientAddress(form);
      if (resolved && geocodingField) geocodingField.value = resolved.source;
    } catch (error) {
      console.warn('Autogeocoding client address failed:', error);
    }
  };

  addressInput.addEventListener('blur', runGeocoding);
  addressInput.addEventListener('input', () => {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(runGeocoding, 900);
  });
}

function calculateClientLoyalty(client, orders = []) {
  const completedOrders = orders.filter((order) => String(order.status || '').toLowerCase() === 'entregado');
  const totalSpent = completedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const monthsActive = Math.max(1, (Date.now() - new Date(client.created_at || Date.now()).getTime()) / (1000 * 60 * 60 * 24 * 30));
  const frequencyScore = Math.min(completedOrders.length * 12, 50);
  const spendScore = Math.min(totalSpent / 10000, 30);
  const tenureScore = Math.min(monthsActive * 2, 20);
  const loyaltyScore = Math.min(Math.round(frequencyScore + spendScore + tenureScore), 100);

  return {
    loyaltyScore,
    ordersCount: completedOrders.length,
    totalSpent,
    monthsActive: Number(monthsActive.toFixed(1)),
    segment: loyaltyScore >= 80 ? 'VIP' : loyaltyScore >= 50 ? 'Leal' : loyaltyScore >= 25 ? 'Frecuente' : 'Nuevo'
  };
}

function generateClientOrderHistory(orders = []) {
  if (!Array.isArray(orders) || !orders.length) {
    return '<div class="subtle">Sin pedidos registrados.</div>';
  }

  return orders.map((order) => `
    <article class="client-history-card timeline-item" data-status="${String(order.status || '').toLowerCase()}">
      <div class="timeline-icon client-history-icon">
        <span class="material-symbols-rounded">receipt_long</span>
      </div>
      <div class="timeline-body client-history-body">
        <div class="client-history-head">
          <h4>Pedido #${order.id}</h4>
          <span class="client-history-date">${formatBogotaDateTime(order.created_at)}</span>
        </div>
        <div class="timeline-meta client-history-meta">${escapeHtml(order.barrio || 'Sin barrio')} · ${escapeHtml(order.address || 'Sin dirección')}</div>
        <div class="tag-row client-history-tags" style="margin-top:8px;">
          <span class="tag">${money(order.total)}</span>
          <span class="tag ${getOrderStatusClass(order.status)}">${escapeHtml(order.status || '')}</span>
        </div>
      </div>
      <div class="client-history-amount">${money(order.total)}</div>
    </article>
  `).join('');
}

function analyzeClientPreferences(orders = []) {
  const productCounts = new Map();
  const barrioCounts = new Map();

  orders.forEach((order) => {
    const barrio = String(order.barrio || '').trim();
    if (barrio) barrioCounts.set(barrio, (barrioCounts.get(barrio) || 0) + 1);

    (order.items || []).forEach((item) => {
      const key = String(item.name_snapshot || item.name || '').trim();
      if (!key) return;
      productCounts.set(key, (productCounts.get(key) || 0) + Number(item.quantity || 1));
    });
  });

  const topProduct = Array.from(productCounts.entries()).sort((a, b) => b[1] - a[1])[0] || null;
  const topZone = Array.from(barrioCounts.entries()).sort((a, b) => b[1] - a[1])[0] || null;

  return {
    favoriteProduct: topProduct ? { name: topProduct[0], quantity: topProduct[1] } : null,
    favoriteZone: topZone ? { name: topZone[0], visits: topZone[1] } : null,
    totalOrders: orders.length,
    repeatRate: orders.length >= 2 ? Math.round((orders.filter((order) => String(order.status || '').toLowerCase() === 'entregado').length / orders.length) * 100) : 0
  };
}

async function createNewClient(clientData) {
  const validation = validateAddressFormat(clientData);
  if (!validation.isValid) throw new Error(validation.errorMessage);

  return request('/api/clients/resolve', {
    method: 'POST',
    body: JSON.stringify({
      name: clientData.name,
      phone: clientData.phone,
      notes: clientData.notes || '',
      address: clientData.address,
      barrio: clientData.barrio,
      reference: clientData.reference,
      latitude: clientData.latitude,
      longitude: clientData.longitude,
      geocodingSource: clientData.geocodingSource,
      setPrimaryAddress: true
    })
  });
}

async function updateClientProfile(clientId, clientData) {
  const validation = validateAddressFormat(clientData);
  if (!validation.isValid) throw new Error(validation.errorMessage);

  return request(`/api/clients/${clientId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: clientData.name,
      phone: clientData.phone,
      notes: clientData.notes || ''
    })
  });
}

async function deleteClient(clientId) {
  return request(`/api/clients/${clientId}`, { method: 'DELETE' });
}

async function mergeClientProfiles(targetClientId, sourceClientId) {
  return request(`/api/clients/${targetClientId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ sourceClientId })
  });
}

async function archiveInactiveClients(clientId) {
  return request(`/api/clients/${clientId}/archive`, { method: 'PATCH' });
}

async function restoreClient(clientId) {
  return request(`/api/clients/${clientId}/restore`, { method: 'PATCH' });
}

async function addClientAddress(clientId, addressData) {
  const validation = validateAddressFormat(addressData);
  if (!validation.isValid) throw new Error(validation.errorMessage);

  return request(`/api/clients/${clientId}/addresses`, {
    method: 'POST',
    body: JSON.stringify(addressData)
  });
}

async function updateClientAddress(addressId, addressData) {
  const validation = validateAddressFormat(addressData);
  if (!validation.isValid) throw new Error(validation.errorMessage);

  return request(`/api/addresses/${addressId}`, {
    method: 'PATCH',
    body: JSON.stringify(addressData)
  });
}

async function setPrimaryAddress(addressId) {
  return request(`/api/addresses/${addressId}/primary`, { method: 'PATCH' });
}

async function deleteClientAddress(addressId) {
  return request(`/api/addresses/${addressId}`, { method: 'DELETE' });
}

function parseComboItems(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch (_error) {
    // Fall through to plain-text parsing.
  }

  return String(value)
    .split(/\r?\n|,/)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function formatComboItems(value) {
  return parseComboItems(value).join('\n');
}

function buildProductModalBody(product = null, suggestions = []) {
  const comboItems = parseComboItems(product?.combo_items);
  const isCombo = comboItems.length > 0 || String(product?.category || '').toLowerCase().includes('combo');
  const suggestionList = suggestions
    .map((item) => String(item).trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .filter((item) => !comboItems.includes(item));
  const suggestionMarkup = suggestionList.length
    ? suggestionList.map((item) => `<button type="button" class="combo-chip option" data-combo-option="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')
    : '<div class="combo-empty">No hay productos base sugeridos todavía.</div>';
  const selectedMarkup = comboItems.length
    ? comboItems.map((item) => `<button type="button" class="combo-chip selected" data-combo-selected="${escapeHtml(item)}">${escapeHtml(item)}<span>×</span></button>`).join('')
    : '<div class="combo-empty">Aún no hay ítems seleccionados.</div>';

  return `
    <form id="productForm" class="order-form product-form">
      <div class="product-form-hero">
        <div>
          <p class="eyebrow">${product ? 'Editar producto' : 'Nuevo producto'}</p>
          <h3>${product ? 'Ajusta la información del catálogo' : 'Agrega un nuevo ítem al catálogo'}</h3>
        </div>
        <label class="combo-switch">
          <input type="checkbox" name="isCombo" ${isCombo ? 'checked' : ''} />
          <span>
            <strong>Es combo</strong>
            <small>Activa esta opción si agrupa varios ítems del catálogo.</small>
          </span>
        </label>
      </div>

      <div class="form-grid-modal product-form-grid">
        <div class="stack-form">
          <label class="subtle">Nombre</label>
          <input name="name" type="text" value="${escapeHtml(product?.name || '')}" placeholder="Ej: Combo Wok Familiar" required />
        </div>
        <div class="stack-form">
          <label class="subtle">Categoría</label>
          <input name="category" type="text" value="${escapeHtml(product?.category || 'General')}" placeholder="Ej: Combos" required />
        </div>
      </div>

      <div class="form-grid-modal product-form-grid">
        <div class="stack-form">
          <label class="subtle">Precio</label>
          <input name="price" type="number" value="${escapeHtml(product?.price ?? '')}" min="0" step="100" placeholder="0" required />
        </div>
        <div class="stack-form">
          <label class="subtle">Estado visible</label>
          <select name="active">
            <option value="1" ${product && Number(product.active) === 1 ? 'selected' : ''}>Activo</option>
            <option value="0" ${product && Number(product.active) === 0 ? 'selected' : ''}>Inactivo</option>
          </select>
        </div>
      </div>

      <div class="combo-builder" data-combo-builder>
        <div class="combo-builder-head">
          <div>
            <label class="subtle">Ítems incluidos en el combo</label>
            <div class="combo-helper">Selecciona productos sugeridos o agrega uno personalizado. Se guardará como una lista visual, no como texto libre.</div>
          </div>
          <span class="combo-counter" data-combo-count>${comboItems.length} ítem(s)</span>
        </div>

        <input type="hidden" name="comboItems" value='${escapeHtml(JSON.stringify(comboItems))}' data-combo-input />

        <div class="combo-section">
          <div class="combo-section-title">Sugeridos del catálogo</div>
          <div class="combo-chip-grid" data-combo-options>${suggestionMarkup}</div>
        </div>

        <div class="combo-section">
          <div class="combo-section-title">Seleccionados</div>
          <div class="combo-chip-grid selected" data-combo-selected-list>${selectedMarkup}</div>
        </div>

        <div class="combo-custom-row">
          <input type="text" data-combo-custom placeholder="Agregar ítem personalizado" />
          <button type="button" class="btn-secondary" data-combo-add>Agregar</button>
        </div>
      </div>
    </form>
  `;
}

function openProductModal(product = null) {
  const comboSuggestions = dashboardState.products
    .filter((item) => Number(item.active) === 1)
    .filter((item) => !parseComboItems(item.combo_items).length)
    .filter((item) => !product || Number(item.id) !== Number(product.id))
    .map((item) => item.name);

  showModal({
    title: product ? 'Editar Producto' : 'Nuevo Producto',
    body: buildProductModalBody(product, comboSuggestions),
    confirmText: null,
    cancelText: 'Cancelar',
    isWide: true
  });

  queueMicrotask(() => {
    const form = document.getElementById('productForm');
    if (!form) {
      return;
    }

    const comboToggle = form.querySelector('[name="isCombo"]');
    const comboInput = form.querySelector('[data-combo-input]');
    const selectedList = form.querySelector('[data-combo-selected-list]');
    const optionsList = form.querySelector('[data-combo-options]');
    const countBadge = form.querySelector('[data-combo-count]');
    const customInput = form.querySelector('[data-combo-custom]');
    const addButton = form.querySelector('[data-combo-add]');

    const setComboItems = (items) => {
      const uniqueItems = items.map((item) => String(item).trim()).filter(Boolean).filter((item, index, array) => array.indexOf(item) === index);
      comboInput.value = JSON.stringify(uniqueItems);
      countBadge.textContent = `${uniqueItems.length} ítem(s)`;

      if (!uniqueItems.length) {
        selectedList.innerHTML = '<div class="combo-empty">Aún no hay ítems seleccionados.</div>';
      } else {
        selectedList.innerHTML = uniqueItems.map((item) => `
          <button type="button" class="combo-chip selected" data-combo-selected="${escapeHtml(item)}">
            ${escapeHtml(item)}<span>×</span>
          </button>
        `).join('');
      }

      const selectedSet = new Set(uniqueItems);
      optionsList.querySelectorAll('[data-combo-option]').forEach((button) => {
        button.classList.toggle('is-selected', selectedSet.has(button.dataset.comboOption));
        button.disabled = selectedSet.has(button.dataset.comboOption);
      });
    };

    setComboItems(parseComboItems(comboInput.value));

    const syncComboVisibility = () => {
      const enabled = comboToggle.checked;
      form.querySelector('[data-combo-builder]').classList.toggle('is-disabled', !enabled);
      form.querySelectorAll('[data-combo-builder] button, [data-combo-builder] input').forEach((node) => {
        if (node.matches('[name="isCombo"]')) {
          return;
        }
        if (node.matches('[data-combo-input]')) {
          node.disabled = false;
          return;
        }
        node.disabled = !enabled;
      });
      if (!enabled) {
        comboInput.value = '[]';
        setComboItems([]);
      }
    };

    comboToggle.addEventListener('change', syncComboVisibility);

    optionsList.addEventListener('click', (event) => {
      const target = event.target.closest('[data-combo-option]');
      if (!target || target.disabled) {
        return;
      }
      const nextItems = parseComboItems(comboInput.value);
      nextItems.push(target.dataset.comboOption);
      setComboItems(nextItems);
    });

    selectedList.addEventListener('click', (event) => {
      const target = event.target.closest('[data-combo-selected]');
      if (!target) {
        return;
      }
      const nextItems = parseComboItems(comboInput.value).filter((item) => item !== target.dataset.comboSelected);
      setComboItems(nextItems);
    });

    const addCustomItem = () => {
      const value = customInput.value.trim();
      if (!value) {
        return;
      }
      const nextItems = parseComboItems(comboInput.value);
      nextItems.push(value);
      setComboItems(nextItems);
      customInput.value = '';
      customInput.focus();
    };

    addButton.addEventListener('click', addCustomItem);
    customInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addCustomItem();
      }
    });

    syncComboVisibility();

    form.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const data = getFormData(form);
      const comboItems = data.isCombo === 'on' ? parseComboItems(data.comboItems) : [];

      try {
        if (product) {
          await request(`/api/products/${product.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: data.name,
              category: data.category,
              price: Number(data.price),
              active: data.active === '1',
              comboItems
            })
          });
          showToast('Producto actualizado', 'success');
        } else {
          await request('/api/products', {
            method: 'POST',
            body: JSON.stringify({
              name: data.name,
              category: data.category,
              price: Number(data.price),
              active: data.active === '1',
              comboItems
            })
          });
          showToast('Producto creado', 'success');
        }

        closeModals();
        await refreshDashboard();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }, { once: true });
  });
}

// --- Funciones de Gestión de Clientes (Movidas al nivel superior para evitar errores de scope) ---

function openClientModal(client = null) {
  const template = document.getElementById('clientFormTemplate');
  showModal({
    title: client ? `Editar Cliente: ${client.name}` : 'Registrar Nuevo Cliente',
    body: template.innerHTML,
    confirmText: null,
    cancelText: 'Cancelar',
    isWide: true
  });

  const modalBody = document.querySelector('.modal-body');
  const form = modalBody.querySelector('#clientForm');
  if (!form) {
    showToast('No se pudo abrir el formulario de cliente.', 'error');
    return;
  }

  const setFieldValue = (fieldName, value) => {
    const field = form.querySelector(`[name="${fieldName}"]`);
    if (field) field.value = value ?? '';
  };

  if (client) {
    // Lógica de Pestañas
    const links = modalBody.querySelectorAll('.tab-link');
    const contents = modalBody.querySelectorAll('.tab-content');
    links.forEach(link => {
      link.onclick = () => {
        const target = link.dataset.tab;
        links.forEach(l => l.classList.toggle('active', l === link));
        contents.forEach(c => c.classList.toggle('active', c.id === target));
        if (target === 'client-history') renderClientHistory(client.id, modalBody.querySelector('#history-list'));
      };
    });

    // Llenar Formulario
    setFieldValue('clientId', client.id);
    setFieldValue('name', client.name);
    setFieldValue('phone', client.phone);
    setFieldValue('notes', client.notes || '');
    if (client.primaryAddress) {
      setFieldValue('address', client.primaryAddress.address);
      setFieldValue('barrio', client.primaryAddress.barrio);
      setFieldValue('reference', client.primaryAddress.reference);
      setFieldValue('urgencyLevel', client.primaryAddress.urgency_level || 'low');
      setFieldValue('deliveryBufferMinutes', client.primaryAddress.delivery_buffer_minutes || 0);
      setFieldValue('geocodingSource', client.primaryAddress.geocoding_source || '');
      setFieldValue('latitude', client.primaryAddress.latitude || '');
      setFieldValue('longitude', client.primaryAddress.longitude || '');
    }
  } else {
    modalBody.querySelector('.tabs').style.display = 'none';
  }
  attachGeocoding(modalBody);
  attachClientAddressAutoGeocoding(modalBody);
  const validateBtn = modalBody.querySelector('#validateClientAddressBtn');
  if (validateBtn) validateBtn.addEventListener('click', async () => {
    const form = document.getElementById('clientForm');
    const resolved = await resolveOrderLocation(form);
    const geocodingField = form?.querySelector('[name="geocodingSource"]');
    if (resolved && geocodingField) geocodingField.value = resolved.source;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;

    // Intentar geocodificar si no hay coordenadas
    let geocodingSource = form.querySelector('[name="geocodingSource"]')?.value || '';
    if (!form.querySelector('[name="latitude"]')?.value || !form.querySelector('[name="longitude"]')?.value) {
      const resolved = await resolveOrderLocation(form);
      if (resolved) geocodingSource = resolved.source;
    }
    const lat = form.querySelector('[name="latitude"]')?.value;
    const lon = form.querySelector('[name="longitude"]')?.value;
    if (!lat || !lon) {
      showToast('Por favor selecciona una dirección de las sugerencias de Google.', 'error');
      return;
    }

    const data = getFormData(form);
    try {
      const payload = {
        name: data.name,
        phone: data.phone,
        notes: data.notes,
        address: data.address,
        barrio: data.barrio,
        reference: data.reference,
        latitude: data.latitude,
        longitude: data.longitude,
        geocodingSource,
        setPrimaryAddress: true
      };

      if (client?.id) {
        await updateClientProfile(client.id, payload);
        if (payload.address) {
          const addressPayload = {
            label: 'principal',
            address: payload.address,
            barrio: payload.barrio,
            reference: payload.reference,
            latitude: payload.latitude,
            longitude: payload.longitude,
            geocodingSource: payload.geocodingSource
          };
          const addresses = await request(`/api/clients/${client.id}/addresses`);
          const existingAddress = Array.isArray(addresses) ? addresses.find((address) => normalizeNeighborhood(address.address) === normalizeNeighborhood(payload.address) && normalizeNeighborhood(address.barrio) === normalizeNeighborhood(payload.barrio)) : null;
          if (existingAddress) {
            await updateClientAddress(existingAddress.id, addressPayload);
          } else {
            await addClientAddress(client.id, addressPayload);
          }
        }
      } else {
        await createNewClient(payload);
      }

      showToast(client ? 'Cliente actualizado' : 'Cliente registrado con éxito', 'success');
      closeModals();
      await refreshDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function handlePhoneBlur(event) {
  const phone = (event.target.value || '').trim();
  const nameInput = document.querySelector('.modal-body [name="name"]');
  const currentNameInput = nameInput ? (nameInput.value || '').trim() : '';

  if (phone.length >= 7) {
    try {
      const clients = await request(`/api/clients?q=${encodeURIComponent(phone)}`);
      const normalizedPhone = phone.replace(/\D/g, '');
      const existing = clients.find(c => c.phone.replace(/\D/g, '') === normalizedPhone);

      if (existing) {
        if (currentNameInput && currentNameInput.toLowerCase() !== existing.name.toLowerCase()) {
          showModal({
            title: 'Cliente detectado',
            body: `El teléfono <strong>${phone}</strong> ya está registrado a nombre de <strong>${existing.name}</strong>.<br><br>¿Deseas cargar sus datos guardados?`,
            confirmText: 'Sí, usar datos',
            cancelText: 'No, es otro cliente',
            onConfirm: () => fillOrderClientData(existing)
          });
          return;
        }
        fillOrderClientData(existing);
      }
    } catch (e) {
      console.error('Error al buscar cliente para auto-completado', e);
    }
  }
}

function syncOrderClientAddress(form, address) {
  if (!form || !address) return;

  const setFieldValue = (selector, value) => {
    const field = form.querySelector(selector);
    if (field) field.value = value ?? '';
  };

  setFieldValue('[name="address"]', address.address);
  setFieldValue('[name="barrio"]', address.barrio);
  setFieldValue('[name="reference"]', address.reference || '');
  setFieldValue('[name="latitude"]', address.latitude || '');
  setFieldValue('[name="longitude"]', address.longitude || '');
  setFieldValue('[name="geocodingSource"]', address.geocoding_source || address.geocodingSource || '');
  setFieldValue('[name="selectedAddressId"]', address.id || '');

  const addrInp = form.querySelector('[name="address"]');
  const barrioInp = form.querySelector('[name="barrio"]');
  const refInp = form.querySelector('[name="reference"]');
  const autocompleteEl = form.__addressAutocompleteEl;
  const innerInput = autocompleteEl?.shadowRoot?.querySelector('input');
  if (addrInp) addrInp.value = address.address || '';
  if (innerInput) innerInput.value = address.address || '';
  if (barrioInp) barrioInp.value = address.barrio || '';
  if (refInp) refInp.value = address.reference || '';
}

function renderOrderSavedAddresses(form, client) {
  const wrap = form.querySelector('#orderSavedAddressWrap');
  const select = form.querySelector('#orderSavedAddressSelect');
  const selectedAddressField = form.querySelector('[name="selectedAddressId"]');
  const addresses = Array.isArray(client?.addresses) ? client.addresses : [];

  if (!wrap || !select || !selectedAddressField) return;

  if (!addresses.length) {
    wrap.style.display = 'none';
    select.innerHTML = '';
    selectedAddressField.value = '';
    return;
  }

  wrap.style.display = 'block';
  form.__selectedClientAddresses = addresses;
  select.innerHTML = addresses.map((address) => `
    <option value="${address.id}">${escapeHtml(address.label || 'Dirección')} · ${escapeHtml(address.address || '')} ${address.is_primary ? '(Principal)' : ''}</option>
  `).join('');

  const primaryAddress = addresses.find((address) => Number(address.is_primary) === 1) || addresses[0];
  select.value = String(primaryAddress.id);
  selectedAddressField.value = String(primaryAddress.id);
  syncOrderClientAddress(form, primaryAddress);
}

async function fillOrderClientData(client, targetForm = document.querySelector('#orderForm')) {
  const form = targetForm;
  if (!form) return;

  const setFieldValue = (selector, value) => {
    const field = form.querySelector(selector);
    if (field) field.value = value ?? '';
  };

  setFieldValue('[name="clientId"]', client.id || '');
  const nameInp = form.querySelector('[name="name"]');
  if (nameInp) nameInp.value = client.name;

  if (client.primaryAddress) {
    syncOrderClientAddress(form, client.primaryAddress);
  }

  renderOrderSavedAddresses(form, client);
  showToast(`Cliente ${client.name} vinculado`, 'info');
}

// --- Funciones de Gestión de Comandas (Movidas al nivel superior) ---

function attachOrderFormEvents(container = document, editingOrder = null) {
  if (container) {
    const form = container.querySelector('#orderForm');
    if (!form) return;
    attachGeocoding(form);
    const productSelect = form.querySelector('#orderProductSelect');
    const productSearch = form.querySelector('#orderProductSearch');
    const nameInput = form.querySelector('[name="name"]');
    const phoneInput = form.querySelector('[name="phone"]');
    const clientIdField = form.querySelector('[name="clientId"]');
    const selectedAddressField = form.querySelector('[name="selectedAddressId"]');
    const clientLookupPanel = form.querySelector('#orderClientMatchPanel');
    const clientLookupResults = form.querySelector('#orderClientMatchResults');
    const savedAddressWrap = form.querySelector('#orderSavedAddressWrap');
    const savedAddressSelect = form.querySelector('#orderSavedAddressSelect');
    let clientLookupTimer = null;

    const setFieldValue = (selector, value) => {
      const field = form.querySelector(selector);
      if (field) field.value = value ?? '';
    };

    const clearClientSelection = () => {
      if (clientIdField) clientIdField.value = '';
      if (selectedAddressField) selectedAddressField.value = '';
      if (savedAddressWrap) savedAddressWrap.style.display = 'none';
      if (savedAddressSelect) savedAddressSelect.innerHTML = '';
      if (clientLookupPanel) clientLookupPanel.style.display = 'none';
      if (clientLookupResults) clientLookupResults.innerHTML = '';
    };

    const renderClientSuggestions = (clients, query) => {
      if (!clientLookupPanel || !clientLookupResults) return;
      if (!Array.isArray(clients) || !clients.length) {
        clientLookupPanel.style.display = 'none';
        clientLookupResults.innerHTML = '';
        return;
      }

      clientLookupPanel.style.display = 'block';
      clientLookupResults.innerHTML = clients.slice(0, 5).map((client) => {
        const primaryAddress = client.primaryAddress || client.addresses?.find((address) => Number(address.is_primary) === 1) || client.addresses?.[0] || null;
        return `
          <button type="button" data-order-client-id="${client.id}" style="text-align:left; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--panel-border); background: rgba(255,255,255,0.03); color: var(--text-primary); display: flex; flex-direction: column; gap: 4px;">
            <div style="display:flex; justify-content:space-between; gap: 10px; align-items:center;">
              <strong style="font-size: 13px;">${escapeHtml(client.name)}</strong>
              <span class="subtle" style="font-size: 11px;">${escapeHtml(client.phone)}</span>
            </div>
            <div class="subtle" style="font-size: 11px;">${primaryAddress ? `${escapeHtml(primaryAddress.address || '')} · ${escapeHtml(primaryAddress.barrio || '')}` : 'Sin dirección principal'}</div>
            <div class="subtle" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;">${client.addressCount || client.addresses?.length || 0} dirección(es)</div>
          </button>
        `;
      }).join('');

      clientLookupResults.querySelectorAll('[data-order-client-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const client = clients.find((item) => Number(item.id) === Number(button.dataset.orderClientId));
          if (client) {
            await fillOrderClientData(client, form);
            clientLookupPanel.style.display = 'none';
          }
        });
      });
    };

    const lookupClientMatches = async (query) => {
      const term = String(query || '').trim();
      if (term.length < 2) {
        clientLookupPanel && (clientLookupPanel.style.display = 'none');
        return;
      }

      try {
        const clients = await request(`/api/clients?q=${encodeURIComponent(term)}`);
        const matches = Array.isArray(clients) ? clients : [];
        const normalizedTerm = term.toLowerCase();
        const normalizedPhone = term.replace(/\D/g, '');
        const exactMatch = matches.find((client) => normalizePhone(client.phone) === normalizedPhone) || matches.find((client) => String(client.name || '').trim().toLowerCase() === normalizedTerm);

        if (exactMatch) {
          await fillOrderClientData(exactMatch, form);
          return;
        }

        renderClientSuggestions(matches, term);
      } catch (error) {
        console.warn('Error buscando clientes para la comanda:', error);
      }
    };

    const handleClientFieldInput = (inputValue) => {
      clearClientSelection();
      window.clearTimeout(clientLookupTimer);
      clientLookupTimer = window.setTimeout(() => lookupClientMatches(inputValue), 300);
    };

    if (nameInput) {
      nameInput.addEventListener('input', (event) => handleClientFieldInput(event.target.value));
      nameInput.addEventListener('blur', (event) => lookupClientMatches(event.target.value));
    }

    if (phoneInput) {
      phoneInput.addEventListener('input', (event) => handleClientFieldInput(event.target.value));
      phoneInput.addEventListener('blur', (event) => lookupClientMatches(event.target.value));
    }

    if (savedAddressSelect) {
      savedAddressSelect.addEventListener('change', () => {
        const addresses = form.__selectedClientAddresses || [];
        const selectedAddress = addresses.find((address) => String(address.id) === String(savedAddressSelect.value));
        if (selectedAddress) {
          syncOrderClientAddress(form, selectedAddress);
          if (selectedAddressField) selectedAddressField.value = String(selectedAddress.id);
        }
      });
    }

    if (editingOrder) {
      setFieldValue('[name="clientId"]', editingOrder.client_id || '');
      setFieldValue('[name="name"]', editingOrder.client_name);
      setFieldValue('[name="phone"]', editingOrder.client_phone);
      setFieldValue('[name="address"]', editingOrder.address);
      setFieldValue('[name="barrio"]', editingOrder.barrio);
      setFieldValue('[name="reference"]', editingOrder.reference || '');
      setFieldValue('[name="paymentMethod"]', editingOrder.payment_method);
      setFieldValue('[name="driverId"]', editingOrder.driver_id || '');
      setFieldValue('[name="notes"]', editingOrder.notes || '');
      if (editingOrder.latitude) setFieldValue('[name="latitude"]', editingOrder.latitude);
      if (editingOrder.longitude) setFieldValue('[name="longitude"]', editingOrder.longitude);
      form.dataset.pendingAddress = editingOrder.address || '';
      setFieldValue('[name="urgencyLevel"]', editingOrder.urgency_level || 'low');
      setFieldValue('[name="deliveryBufferMinutes"]', editingOrder.delivery_buffer_minutes || 0);
      setFieldValue('[name="geocodingSource"]', editingOrder.geocoding_source || '');
      setFieldValue('[name="selectedAddressId"]', editingOrder.selected_address_id || '');
    }

    const updateProductList = (query = '') => {
      const term = query.toLowerCase().trim();
      productSelect.innerHTML = dashboardState.products
        .filter(p => p.active && p.name.toLowerCase().includes(term))
        .map(p => `<option value="${p.id}">${p.name} - ${money(p.price)}</option>`).join('');
    };
    updateProductList();
    productSearch.addEventListener('input', (e) => updateProductList(e.target.value));
    const driverSelect = form.querySelector('#orderDriverSelect');
    driverSelect.innerHTML = '<option value="">Sin asignar</option>' +
      dashboardState.drivers.filter(d => d.active).map(d => `<option value="${d.id}">${d.name}</option>`).join('');
    form.querySelector('#addItemButton').addEventListener('click', () => {
      const productId = Number(productSelect.value);
      const qtyInput = form.querySelector('#orderQuantityInput');
      const qty = Number(qtyInput.value) || 1;
      const product = dashboardState.products.find(p => p.id === productId);
      pendingItems.push({ productId, quantity: qty, name: product.name, unitPrice: product.price });
      qtyInput.value = 1;
      renderPendingItemsInModal();
    });
    form.querySelector('[name="phone"]').addEventListener('blur', handlePhoneBlur);
    // Escuchar cambios en el input de costo de domicilio para recalcular totales
    const shippingInput = form.querySelector('#orderShippingInput') || form.querySelector('[name="shipping"]');
    if (shippingInput) {
      shippingInput.addEventListener('input', () => renderPendingItemsInModal());
    }

    // Event listeners para tipo de pago y cambio
    const paymentTypeSelect = form.querySelector('#paymentTypeSelect');
    const paymentChangeFields = form.querySelector('#paymentChangeFields');
    const paymentAmountInput = form.querySelector('#paymentAmountInput');
    
    if (paymentTypeSelect && paymentChangeFields) {
      // Mostrar/ocultar campos de cambio según el tipo de pago
      const togglePaymentFields = () => {
        if (paymentTypeSelect.value === 'change') {
          paymentChangeFields.style.display = 'flex';
        } else {
          paymentChangeFields.style.display = 'none';
          if (paymentAmountInput) paymentAmountInput.value = '';
        }
      };
      
      paymentTypeSelect.addEventListener('change', togglePaymentFields);
      togglePaymentFields(); // Inicializar
    }
    
    // Recalcular cambio cuando se ingresa el monto pagado
    if (paymentAmountInput) {
      paymentAmountInput.addEventListener('input', () => renderPendingItemsInModal());
    }

    // Evento para el botón de validar dirección en el formulario de comanda
    const validateBtn = form.querySelector('#validateOrderAddressBtn');
    if (validateBtn) validateBtn.addEventListener('click', async () => {
      const resolved = await resolveOrderLocation(form);
      if (resolved) form.querySelector('[name="geocodingSource"]').value = resolved.source;
    });

    // ========== BOTONES DE UTILIDADES ==========
    
    // Botón: Duplicar última comanda
    const duplicateBtn = form.querySelector('#duplicateLastOrderBtn');
    if (duplicateBtn) {
      duplicateBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const lastOrder = dashboardState.orders[dashboardState.orders.length - 1];
        if (!lastOrder) {
          showToast('No hay comandas anteriores para duplicar', 'warning');
          return;
        }
        
        // Rellenar datos del cliente
        setFieldValue('[name="name"]', lastOrder.client_name);
        setFieldValue('[name="phone"]', lastOrder.client_phone);
        setFieldValue('[name="address"]', lastOrder.address);
        setFieldValue('[name="barrio"]', lastOrder.barrio);
        setFieldValue('[name="paymentMethod"]', lastOrder.payment_method);
        
        // Limpiar items y agregar los de la comanda anterior (copiar items, qty, precio)
        pendingItems.length = 0;
        if (Array.isArray(lastOrder.items) && lastOrder.items.length) {
          lastOrder.items.forEach(it => {
            const qty = Number(it.quantity) || 1;
            const unitPrice = Number(it.unit_price ?? it.unitPrice ?? 0) || 0;
            pendingItems.push({
              productId: Number(it.product_id || it.productId),
              quantity: qty,
              name: it.name_snapshot || it.name || 'Producto',
              unitPrice
            });
          });
        }

        // Restaurar información de pago si existe
        const paymentTypeField = form.querySelector('[name="paymentType"]');
        const paymentAmountField = form.querySelector('#paymentAmountInput');
        if (paymentTypeField && lastOrder.payment_type) paymentTypeField.value = lastOrder.payment_type;
        if (paymentAmountField && lastOrder.payment_amount) paymentAmountField.value = Number(lastOrder.payment_amount);

        showToast(`✓ Comanda #${lastOrder.id} duplicada (items y pago cargados)`, 'success');
        renderPendingItemsInModal();
      });
    }

    // Botón: Crear desde plantilla
    const templateBtn = form.querySelector('#createFromTemplateBtn');
    if (templateBtn) {
      templateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        showTemplatesModal(form);
      });
    }

    // Botón: Mostrar resumen
    const summaryBtn = form.querySelector('#showOrderSummaryBtn');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (pendingItems.length === 0) {
          showToast('Agrega al menos un producto para ver el resumen', 'warning');
          return;
        }
        
        const orderData = {
          items: pendingItems,
          shipping: Number(form.querySelector('#orderShippingInput')?.value || 3000)
        };
        
        const summary = generateOrderSummary(orderData);
        
        showModal({
          title: '📋 Resumen de Comanda',
          body: summary,
          cancelText: 'Cerrar'
        });
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      form.classList.add('was-validated');
      if (!form.checkValidity() || !pendingItems.length) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        if (!pendingItems.length) showToast('Agrega al menos un producto a la comanda.', 'error');
        else showToast('Faltan datos obligatorios.', 'error');
        return;
      }

      // Intentar resolver coordenadas si no existen, y capturar el origen
      let geocodingSource = form.querySelector('[name="geocodingSource"]')?.value || '';
      if (!form.querySelector('[name="latitude"]')?.value || !form.querySelector('[name="longitude"]')?.value) {
        const resolved = await resolveOrderLocation(form);
        if (resolved) geocodingSource = resolved.source;
      }
      syncOrderAddress(form);

      const data = getFormData(e.target);
      const shippingVal = Number(form.querySelector('#orderShippingInput')?.value || 0) || 0;
      const totals = calculateOrderTotal(pendingItems, shippingVal);

      // Obtener datos de pago
      const paymentTypeSelect = form.querySelector('#paymentTypeSelect');
      const paymentAmountInput = form.querySelector('#paymentAmountInput');
      const paymentType = paymentTypeSelect?.value || 'exact';
      const paymentAmount = paymentType === 'change' ? (Number(paymentAmountInput?.value) || 0) : null;
      const orderItems = pendingItems.map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity) || 1,
        name: item.name,
        unitPrice: Number(item.unitPrice || 0)
      }));

      const orderData = {
        clientId: data.clientId || '',
        clientName: data.name,
        clientPhone: data.phone,
        address: data.address,
        barrio: data.barrio,
        reference: data.reference || '',
        latitude: data.latitude,
        longitude: data.longitude,
        selectedAddressId: data.selectedAddressId || '',
        items: orderItems,
        paymentMethod: data.paymentMethod,
        paymentType,
        paymentAmount,
        change: paymentAmount !== null ? Math.max(0, paymentAmount - totals.total) : null,
        shipping: shippingVal,
        notes: data.notes,
        driverId: data.driverId || null,
        urgencyLevel: data.urgencyLevel,
        total: totals.total
      };

      const validation = validateOrderData(orderData);
      if (!validation.isValid) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        showToast(validation.errorMessage, 'error');
        return;
      }

      const availability = validateProductAvailability(orderData.items);
      if (!availability.allAvailable) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        showToast('Algunos productos no están disponibles', 'error');
        return;
      }

      const minimum = checkMinimumOrderAmount(orderData.total, 15000);
      if (!minimum.meetsMinimum) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        showToast(minimum.message, 'error');
        return;
      }
      
      try {
        if (editingOrder) {
          const itemsUpdated = await updateOrderItems(editingOrder.id, orderData.items);
          if (!itemsUpdated) return;

          const result = await request(`/api/orders/${editingOrder.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              client: {
                clientId: orderData.clientId,
                name: orderData.clientName,
                phone: orderData.clientPhone,
                address: orderData.address,
                barrio: orderData.barrio,
                reference: orderData.reference,
                latitude: orderData.latitude,
                longitude: orderData.longitude
              },
              paymentMethod: orderData.paymentMethod,
              driverId: orderData.driverId,
              notes: orderData.notes,
              geocodingSource,
              urgencyLevel: orderData.urgencyLevel,
              deliveryBufferMinutes: Number(data.deliveryBufferMinutes || 0),
              paymentType,
              paymentAmount,
              change: orderData.change,
              shipping: orderData.shipping,
              selectedAddressId: orderData.selectedAddressId
            })
          });

          showToast('Comanda actualizada', 'success');
          const savedOrderId = Number(result?.order?.id || result?.id || editingOrder?.id || null);
          if (savedOrderId) ordersTableState.selectedId = savedOrderId;
        } else {
          const result = await createNewOrder(orderData);
          const savedOrderId = Number(result?.order?.id || result?.id || null);
          if (savedOrderId) ordersTableState.selectedId = savedOrderId;
        }

        pendingItems.length = 0;
        closeModals();
        await refreshDashboard();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }
}

function renderPendingItemsInModal() {
  const container = document.querySelector('#pendingItems');
  if (!container) return;
  const total = pendingItems.reduce((sum, item) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice ?? item.unit_price ?? 0) || 0;
    return sum + (quantity * unitPrice);
  }, 0);

  const modalRoot = container.closest('.modal-content') || container.closest('.order-panel') || document;
  container.innerHTML = pendingItems.map((item, idx) => `
    <article class="added-item-card" style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--panel-border); border-radius: 12px; padding: 12px; display: flex; align-items: center; gap: 12px; transition: all 0.2s ease;">
      <div style="flex-grow: 1;">
        <div style="font-weight: 700; font-size: 13px; color: var(--text-primary);">${escapeHtml(item.name)}</div>
        <div class="subtle" style="font-size: 11px; margin-top: 2px;">${money(item.unitPrice)} x ${item.quantity}</div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.2); padding: 4px; border-radius: 8px; border: 1px solid var(--panel-border);">
        <button type="button" style="background:none; border:none; color:var(--muted); cursor:pointer; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-weight:800;" onclick="pendingItems[${idx}].quantity = Math.max(1, pendingItems[${idx}].quantity - 1); renderPendingItemsInModal();">-</button>
        <span style="font-size: 12px; font-weight: 800; color: var(--text-primary); min-width: 16px; text-align: center;">${item.quantity}</span>
        <button type="button" style="background:none; border:none; color:var(--muted); cursor:pointer; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-weight:800;" onclick="pendingItems[${idx}].quantity = pendingItems[${idx}].quantity + 1; renderPendingItemsInModal();">+</button>
      </div>
      <div style="text-align: right; min-width: 80px;">
        <div style="font-weight: 800; color: var(--text-primary); font-size: 14px;">${money(item.quantity * item.unitPrice)}</div>
      </div>
      <button type="button" style="background: transparent; border: none; color: var(--danger); cursor: pointer; padding: 4px; opacity: 0.7; transition: opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7" onclick="pendingItems.splice(${idx},1); renderPendingItemsInModal();">
        <span class="material-symbols-rounded" style="font-size: 20px;">delete</span>
      </button>
    </article>
  `).join('');

  const subtotalNode = modalRoot.querySelector('#detailSubtotal'); if (subtotalNode) subtotalNode.textContent = money(total);
  // Leer valor del input de domicilio si existe, fallback a tarifa por defecto
  let shippingVal = 0;
  const shippingInput = modalRoot.querySelector('#orderShippingInput') || modalRoot.querySelector('[name="shipping"]');
  if (shippingInput) {
    shippingVal = Number(shippingInput.value) || 0;
  } else {
    shippingVal = total > 0 ? 3000 : 0;
  }
  const shippingNode = modalRoot.querySelector('#detailShipping'); if (shippingNode) shippingNode.textContent = money(shippingVal);
  const totalToPay = total + shippingVal;
  const totalNode = modalRoot.querySelector('#detailTotal'); if (totalNode) totalNode.textContent = money(totalToPay);

  // Calcular cambio si aplica
  const paymentTypeSelect = modalRoot.querySelector('#paymentTypeSelect');
  const paymentAmountInput = modalRoot.querySelector('#paymentAmountInput');
  const changeAmountNode = modalRoot.querySelector('#changeAmount');
  
  if (paymentTypeSelect && paymentAmountInput && changeAmountNode) {
    const paymentType = paymentTypeSelect.value;
    if (paymentType === 'change') {
      const paymentAmount = Number(paymentAmountInput.value) || 0;
      const change = Math.max(0, paymentAmount - totalToPay);
      changeAmountNode.textContent = money(change);
      
      // Cambiar color del cambio según sea positivo, negativo o cero
      if (change > 0) {
        changeAmountNode.style.color = '#22c55e'; // Verde
      } else if (change < 0) {
        changeAmountNode.style.color = '#ef4444'; // Rojo - falta dinero
      } else {
        changeAmountNode.style.color = '#94a3b8'; // Gris - pago exacto
      }
    }
  }
}

async function renderDeliveryRoutesHistory() {
  const tbody = document.getElementById('deliveryRoutesList');
  const paginationContainer = document.getElementById('deliveryRoutesPagination');
  const tableRange = document.getElementById('deliveryRoutesTableRange');
  const tableTotal = document.getElementById('deliveryRoutesTableTotal');
  if (!tbody) return;

  // Fetch history if not already loaded or if a refresh is needed
  if (deliveryRoutesHistory.length === 0) {
    try {
      deliveryRoutesHistory = await request('/api/delivery-routes');
    } catch (e) {
      console.error('Error fetching delivery routes history:', e);
      showToast('Error al cargar el historial de rutas.', 'error');
      tbody.innerHTML = `<tr><td colspan="7" class="subtle" style="text-align:center;">Error al cargar el historial.</td></tr>`;
      return;
    }
  }

  let filtered = deliveryRoutesHistory;
  const term = (document.getElementById('routeHistorySearchInput')?.value || '').toLowerCase().trim();
  if (term) {
    filtered = filtered.filter(r =>
      String(r.id).includes(term) ||
      String(r.driver_name || '').toLowerCase().includes(term) ||
      r.orders.some(o => String(o.client_name || '').toLowerCase().includes(term) || String(o.address || '').toLowerCase().includes(term))
    );
  }

  const page = 1; // For simplicity, no pagination for now, but structure is there
  const pageSize = filtered.length; // Show all for now
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  tbody.innerHTML = pageItems.map(route => `
    <tr class="orders-row" data-route-id="${route.id}" style="cursor: pointer;">
      <td class="col-id">#${route.id}</td>
      <td class="col-driver">${escapeHtml(route.driver_name || 'N/A')}</td>
      <td class="col-orders">${route.orders.length} pedidos</td>
      <td class="col-distance" style="text-align:right;">${Number(route.total_distance_km).toFixed(1)} km</td>
      <td class="col-eta" style="text-align:right;">${Math.round(Number(route.total_eta_minutes))} min</td>
      <td class="col-time">${formatBogotaDateTime(route.assigned_at)}</td>
      <td class="col-actions"><button class="btn-icon view-route-details" data-route-id="${route.id}">⋯</button></td>
    </tr>
  `).join('');

  if (tableRange) tableRange.textContent = `${start + 1} - ${Math.min(start + pageSize, total)}`;
  if (tableTotal) tableTotal.textContent = total;

  if (paginationContainer) {
    paginationContainer.innerHTML = ''; // No pagination buttons for now
  }

  // Eventos para ver detalles o visualizar en mapa
  tbody.querySelectorAll('.orders-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.view-route-details')) return;
      const routeId = Number(row.dataset.routeId);
      const route = deliveryRoutesHistory.find(r => r.id === routeId);
      if (route) viewHistoricalRoute(route);
    });
  });

  tbody.querySelectorAll('.view-route-details').forEach(btn => {
    btn.addEventListener('click', () => {
      const routeId = Number(btn.dataset.routeId);
      const route = deliveryRoutesHistory.find(r => r.id === routeId);
      if (route) showRouteDetailsModal(route);
    });
  });
}

/**
 * Cambia a la vista de rutas y carga una ruta del historial en el mapa
 */
function viewHistoricalRoute(route) {
  const historicalSuggestion = {
    suggestedRoutes: [{
      zone: `Historial #${route.id} - ${route.driver_name || 'N/A'}`,
      orders: route.orders,
      totalDistance: route.total_distance_km,
      totalEta: route.total_eta_minutes
    }],
    isHistory: true
  };

  // Actualizar el estado global para que renderRoutes lo procese
  dashboardState.routeSuggestion = historicalSuggestion;
  dashboardState.selectedSuggestedRouteIndex = 0;

  // Navegar a la pestaña de rutas
  const navItem = document.querySelector('[data-target="routes"]');
  if (navItem) navItem.click();
  
  showToast(`Visualizando Ruta #${route.id} en el mapa`, 'info');
}

// ============================================================================
// FUNCIONES CRÍTICAS DE COMANDA (12 Core Functions)
// ============================================================================

/**
 * 1. validateOrderData - Valida datos completos de comanda
 * @param {Object} orderData - Datos de la comanda
 * @returns {Object} { isValid: boolean, errors: string[] }
 */
function validateOrderData(orderData) {
  const errors = [];
  
  // Validar cliente
  if (!orderData.clientName?.trim()) errors.push('Nombre del cliente es requerido');
  if (!orderData.clientPhone?.trim()) errors.push('Teléfono es requerido');
  if (!/\d{7,10}/.test(orderData.clientPhone?.replace(/\D/g, ''))) {
    errors.push('Teléfono debe tener mínimo 7 dígitos');
  }
  
  // Validar dirección
  if (!orderData.address?.trim()) errors.push('Dirección es requerida');
  if (!orderData.barrio?.trim()) errors.push('Barrio es requerido');
  
  // Validar items
  if (!Array.isArray(orderData.items) || orderData.items.length === 0) {
    errors.push('Debe agregar al menos un producto');
  }
  
  // Validar items individual
  orderData.items?.forEach((item, idx) => {
    if (!item.productId) errors.push(`Item ${idx + 1}: Producto no válido`);
    if (item.quantity < 1) errors.push(`Item ${idx + 1}: Cantidad debe ser mínimo 1`);
  });
  
  // Validar pago
  if (orderData.paymentType === 'change') {
    if (!orderData.paymentAmount) errors.push('Monto pagado es requerido para pago con cambio');
    if (orderData.paymentAmount < orderData.total) {
      errors.push('Monto pagado no puede ser menor al total');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    errorMessage: errors.join(' | ')
  };
}

/**
 * 3. validateProductAvailability - Valida disponibilidad de productos
 * @param {Array} items - Items de la comanda
 * @returns {Object} { allAvailable: boolean, unavailable: Array, warnings: string[] }
 */
function validateProductAvailability(items) {
  const unavailable = [];
  const warnings = [];
  
  items.forEach((item, idx) => {
    const product = dashboardState.products.find(p => p.id === item.productId);
    
    if (!product) {
      unavailable.push({ itemIdx: idx, reason: 'Producto no encontrado' });
    } else if (!product.active) {
      unavailable.push({ itemIdx: idx, reason: 'Producto discontinuado' });
    }
    
    // Validar stock si existe
    if (product?.stock !== undefined && product.stock < item.quantity) {
      warnings.push(`${product.name}: Stock bajo (${product.stock} disponibles)`);
    }
  });
  
  return {
    allAvailable: unavailable.length === 0,
    unavailable,
    warnings,
    isWarning: warnings.length > 0 && unavailable.length === 0
  };
}

/**
 * 4. calculateOrderTotal - Calcula total con impuestos y descuentos
 * @param {Array} items - Items de comanda
 * @param {number} shipping - Costo de domicilio
 * @param {number} discount - Descuento en dinero
 * @param {number} taxRate - Porcentaje de impuesto (0-1)
 * @returns {Object} Desglose de cálculo
 */
function calculateOrderTotal(items = [], shipping = 0, discount = 0, taxRate = 0) {
  const subtotal = items.reduce((sum, item) => {
    const price = Number(item.unitPrice || item.unit_price || 0);
    const qty = Number(item.quantity || 1);
    return sum + (price * qty);
  }, 0);
  
  const beforeTax = subtotal + shipping - discount;
  const tax = beforeTax * taxRate;
  const total = beforeTax + tax;
  
  return {
    subtotal: Math.round(subtotal),
    shipping: Math.round(shipping),
    discount: Math.round(discount),
    beforeTax: Math.round(beforeTax),
    tax: Math.round(tax),
    total: Math.round(total),
    itemCount: items.length,
    taxRate,
    summary: `Subtotal: ${money(subtotal)} + Domicilio: ${money(shipping)} - Desc: ${money(discount)} = ${money(total)}`
  };
}

function resolveOrderShipping(order = {}, subtotal = 0) {
  const explicitShipping = Number(order.shipping ?? order.delivery_fee ?? order.deliveryFee);
  if (Number.isFinite(explicitShipping) && explicitShipping > 0) {
    return explicitShipping;
  }

  const storedTotal = Number(order.total);
  if (Number.isFinite(storedTotal) && storedTotal > subtotal) {
    return storedTotal - subtotal;
  }

  return subtotal > 0 ? 3000 : 0;
}

/**
 * 5. generateOrderSummary - Genera resumen visual de comanda
 * @param {Object} order - Datos de la comanda
 * @returns {string} HTML del resumen
 */
function generateOrderSummary(order) {
  const subtotal = (Array.isArray(order.items) ? order.items : []).reduce((sum, item) => {
    const price = Number(item.unitPrice || item.unit_price || 0);
    const qty = Number(item.quantity || 1);
    return sum + (price * qty);
  }, 0);
  const shipping = resolveOrderShipping(order, subtotal);
  const total = calculateOrderTotal(order.items, shipping);
  const itemsHtml = order.items.map(item => `
    <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0;">
      <span>${escapeHtml(item.name || 'Producto')} x${item.quantity}</span>
      <strong>${money(item.quantity * (item.unitPrice || 0))}</strong>
    </div>
  `).join('');
  
  return `
    <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; font-size: 13px;">
      <div style="font-weight: 700; margin-bottom: 8px;">📋 Resumen Comanda</div>
      ${itemsHtml}
      <div style="border-top: 1px solid rgba(255,255,255,0.1); margin-top: 8px; padding-top: 8px;">
        <div style="display: flex; justify-content: space-between;">
          <span>Subtotal:</span><strong>${money(total.subtotal)}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Domicilio:</span><strong>${money(total.shipping)}</strong>
        </div>
        ${total.discount > 0 ? `
          <div style="display: flex; justify-content: space-between; color: #22c55e;">
            <span>Descuento:</span><strong>-${money(total.discount)}</strong>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; font-weight: 800; font-size: 14px; color: var(--accent); margin-top: 8px;">
          <span>TOTAL:</span><strong>${money(total.total)}</strong>
        </div>
      </div>
    </div>
  `;
}

/**
 * 6. checkMinimumOrderAmount - Verifica monto mínimo de comanda
 * @param {number} total - Total de la comanda
 * @param {number} minimum - Monto mínimo permitido
 * @returns {Object} { meetsMinimum: boolean, required: number, missing: number }
 */
function checkMinimumOrderAmount(total = 0, minimum = 15000) {
  const meets = total >= minimum;
  return {
    meetsMinimum: meets,
    required: minimum,
    current: total,
    missing: Math.max(0, minimum - total),
    message: meets 
      ? `✓ Cumple monto mínimo (${money(minimum)})`
      : `Falta ${money(minimum - total)} para el monto mínimo`
  };
}

/**
 * 7. createNewOrder - Crea nueva comanda (frontend + API)
 * @param {Object} orderData - Datos de la comanda
 * @returns {Promise<Object>} Comanda creada
 */
async function createNewOrder(orderData) {
  try {
    // Validar
    const validation = validateOrderData(orderData);
    if (!validation.isValid) {
      throw new Error(validation.errorMessage);
    }
    
    // Verificar disponibilidad
    const availability = validateProductAvailability(orderData.items);
    if (!availability.allAvailable) {
      throw new Error('Algunos productos no están disponibles');
    }
    
    // Verificar monto mínimo
    const minimum = checkMinimumOrderAmount(orderData.total, 15000);
    if (!minimum.meetsMinimum) {
      throw new Error(minimum.message);
    }
    
    // Enviar al servidor
    const result = await request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        client: {
          clientId: orderData.clientId || null,
          name: orderData.clientName,
          phone: orderData.clientPhone,
          address: orderData.address,
          barrio: orderData.barrio,
          reference: orderData.reference,
          latitude: orderData.latitude,
          longitude: orderData.longitude
        },
        items: orderData.items,
        paymentMethod: orderData.paymentMethod,
        paymentType: orderData.paymentType,
        paymentAmount: orderData.paymentAmount,
        change: orderData.change,
        shipping: orderData.shipping,
        notes: orderData.notes,
        driverId: orderData.driverId || null,
        urgencyLevel: orderData.urgencyLevel || 'low',
        selectedAddressId: orderData.selectedAddressId || null
      })
    });
    
    showToast('✓ Comanda creada exitosamente', 'success');
    return result;
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * 8. updateOrderItems - Actualiza items de una comanda
 * @param {number} orderId - ID de la comanda
 * @param {Array} newItems - Nuevos items
 * @returns {Promise<boolean>} Éxito de la operación
 */
async function updateOrderItems(orderId, newItems) {
  try {
    const validation = validateProductAvailability(newItems);
    if (!validation.allAvailable) {
      throw new Error('Algunos productos no están disponibles');
    }
    
    const result = await request(`/api/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ items: newItems })
    });
    
    showToast('Items actualizados', 'success');
    return true;
  } catch (error) {
    showToast(`Error al actualizar: ${error.message}`, 'error');
    return false;
  }
}

/**
 * 9. cancelOrder - Cancela comanda con motivo
 * @param {number} orderId - ID de la comanda
 * @param {string} reason - Motivo de cancelación
 * @returns {Promise<boolean>}
 */
async function cancelOrder(orderId, reason = '') {
  try {
    if (!reason?.trim()) {
      throw new Error('Debe proporcionar un motivo de cancelación');
    }
    
    const confirmed = await new Promise(resolve => {
      showModal({
        title: '⚠️ Cancelar Comanda',
        body: `
          <p>¿Confirma cancelación de comanda #${orderId}?</p>
          <p style="color: var(--muted); font-size: 12px;">Motivo: ${escapeHtml(reason)}</p>
        `,
        confirmText: 'Sí, Cancelar',
        cancelText: 'No',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      });
    });
    
    if (!confirmed) return false;
    
    await request(`/api/orders/${orderId}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ reason })
    });
    
    showToast('✓ Comanda cancelada', 'success');
    await refreshDashboard();
    return true;
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

/**
 * 10. pauseOrder - Pausa comanda temporalmente
 * @param {number} orderId - ID de la comanda
 * @param {string} reason - Motivo de pausa
 * @returns {Promise<boolean>}
 */
async function pauseOrder(orderId, reason = '') {
  try {
    await request(`/api/orders/${orderId}/pause`, {
      method: 'PATCH',
      body: JSON.stringify({ reason })
    });
    
    showToast('⏸ Comanda pausada', 'info');
    await refreshDashboard();
    return true;
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

/**
 * 11. duplicateOrder - Duplica comanda anterior
 * @param {number} sourceOrderId - ID de comanda a duplicar
 * @returns {Promise<Object>} Nueva comanda
 */
async function duplicateOrder(sourceOrderId) {
  try {
    const sourceOrder = dashboardState.orders.find(o => o.id === sourceOrderId);
    if (!sourceOrder) {
      throw new Error('Comanda original no encontrada');
    }
    
    const items = Array.isArray(sourceOrder.items) ? sourceOrder.items.map((item) => ({
      productId: Number(item.product_id || item.productId),
      quantity: Number(item.quantity) || 1,
      unitPrice: Number(item.unit_price ?? item.unitPrice ?? 0) || 0,
      name: item.name_snapshot || item.name || 'Producto'
    })) : [];
    const shipping = Number(sourceOrder.shipping || 3000) || 3000;
    const totals = calculateOrderTotal(items, shipping);
    
    // Crear nueva comanda con mismos datos
    const newOrder = await createNewOrder({
      clientName: sourceOrder.client_name,
      clientPhone: sourceOrder.client_phone,
      address: sourceOrder.address,
      barrio: sourceOrder.barrio,
      reference: sourceOrder.reference,
      latitude: sourceOrder.latitude,
      longitude: sourceOrder.longitude,
      items,
      paymentMethod: sourceOrder.payment_method,
      shipping,
      total: totals.total,
      notes: `Duplicado de #${sourceOrderId}: ${sourceOrder.notes || ''}`
    });
    
    showToast(`✓ Comanda #${sourceOrderId} duplicada`, 'success');
    return newOrder;
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
    return null;
  }
}

/**
 * 12. createOrderFromTemplate - Crea comanda desde plantilla
 * @param {Object} template - Plantilla de comanda
 * @returns {Promise<Object>} Nueva comanda
 */
async function createOrderFromTemplate(template) {
  try {
    if (!template || !template.items) {
      throw new Error('Plantilla inválida');
    }
    const shipping = Number(template.shipping || 3000) || 3000;
    const totals = calculateOrderTotal(template.items, shipping);
    
    const newOrder = await createNewOrder({
      clientName: template.clientName || '',
      clientPhone: template.clientPhone || '',
      address: template.address || '',
      barrio: template.barrio || '',
      reference: template.reference || '',
      items: template.items,
      paymentMethod: template.paymentMethod || 'Efectivo',
      shipping,
      total: totals.total,
      notes: `De plantilla: ${template.name || 'Sin nombre'}`
    });
    
    showToast(`✓ Comanda creada desde plantilla "${template.name}"`, 'success');
    return newOrder;
  } catch (error) {
    showToast(`Error: ${error.message}`, 'error');
    return null;
  }
}

// ============================================================================

function openOrderPanel() {
    const panel = document.getElementById('orderPanel');
    const body = document.getElementById('orderPanelBody');
    const template = document.getElementById('orderFormTemplate');
    body.innerHTML = template.innerHTML;
  panel.classList.add('open');
  attachOrderFormEvents(body);
  renderPendingItemsInModal();
}

function closeOrderPanel() {
  const panel = document.getElementById('orderPanel');
  if (!panel) return;
  panel.classList.remove('open');
  const body = document.getElementById('orderPanelBody');
  if (body) body.innerHTML = '';
}

function showRouteDetailsModal(route) {
  const ordersHtml = route.orders.map((order, index) => `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid var(--panel-border);">
      <span style="font-weight:bold; font-size:1.2em; color:var(--accent);">${index + 1}.</span>
      <div>
        <strong>${escapeHtml(order.client_name || `Pedido #${order.id}`)}</strong>
        <div class="subtle">${escapeHtml(order.address || 'Sin dirección')} (${escapeHtml(order.barrio || 'Sin barrio')})</div>
        <div class="subtle" style="font-size:0.8em;">Urgencia: ${escapeHtml(order.urgency_level || 'Baja')} · Buffer: ${order.delivery_buffer_minutes || 0} min</div>
      </div>
    </div>
  `).join('');

  const body = `
    <div style="display:flex; flex-direction:column; gap:15px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h4 style="margin:0;">Ruta #${route.id}</h4>
        <span class="insight-chip neutral">${escapeHtml(route.driver_name || 'Sin asignar')}</span>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.9em;">
        <div><strong>Pedidos:</strong> ${route.orders.length}</div>
        <div><strong>Distancia:</strong> ${Number(route.total_distance_km).toFixed(1)} km</div>
        <div><strong>ETA:</strong> ${Math.round(Number(route.total_eta_minutes))} min</div>
        <div><strong>Asignada:</strong> ${formatBogotaDateTime(route.assigned_at)}</div>
      </div>
      <h5 style="margin:0; border-bottom:1px solid var(--panel-border); padding-bottom:5px;">Secuencia de Pedidos:</h5>
      <div style="max-height:300px; overflow-y:auto; padding-right:10px;">
        ${ordersHtml}
      </div>
    </div>
  `;

  showModal({
    title: `Detalles de Ruta #${route.id}`,
    body: body,
    confirmText: 'Cerrar',
    cancelText: null,
  });
}

async function main() {
    // --- Gestión de Clientes ---

    const clientResultsEl = document.getElementById('clientResults');
    if (clientResultsEl) {
      clientResultsEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-client-edit]');
        if (!btn) return;
        const clientId = btn.dataset.clientEdit;
        // Buscar datos completos del cliente en el estado actual
        const clients = await request(`/api/clients?q=${clientId}`); // Búsqueda por ID o similar
        const client = clients.find(c => String(c.id) === clientId);

        if (client) openClientModal(client);
      });
    }

    const clientSearchFormEl = document.getElementById('clientSearchForm');
    if (clientSearchFormEl) {
      clientSearchFormEl.addEventListener('submit', async (event) => {
        event.preventDefault();
        const queryEl = document.getElementById('clientSearchInput');
        const query = queryEl ? queryEl.value.trim() : '';
        await loadClients(query);
      });
    }

    document.getElementById('newProductBtn').addEventListener('click', () => {
      openProductModal();
    });

    document.querySelectorAll('[data-products-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        productsViewFilter = button.dataset.productsFilter;
        renderProducts(dashboardState.products);
      });
    });

    document.getElementById('openDriverModal').addEventListener('click', () => {
      openDriverModal();
    });

    document.getElementById('routeDriverSelect').addEventListener('change', async () => {
      await refreshDashboard();
    });

    document.getElementById('routeLimitSelect').addEventListener('change', async () => {
      await refreshDashboard();
    });

    document.getElementById('routeRefreshBtn').addEventListener('click', async () => {
      await refreshDashboard();
    });

    const useGoogleBtn = document.getElementById('useGoogleBtn');
    if (useGoogleBtn) {
      useGoogleBtn.addEventListener('click', async () => {
        const keyInput = document.getElementById('googleApiKeyInput');
        const key = keyInput ? keyInput.value.trim() : '';
        if (!key) {
          showToast('Pega tu Google Maps API Key en el campo.', 'error');
          return;
        }
        try {
          showToast('Cargando Google Maps SDK...', 'info');
          await loadGoogleMapsSdk(key);
          localStorage.setItem('googleMapsApiKey', key);
          showToast('Google Maps activado. Actualiza el mapa.', 'success');
          await refreshDashboard();
        } catch (err) {
          console.error('Error cargando Google Maps:', err);
          showToast('No se pudo cargar Google Maps. Revisa la clave y la conexión.', 'error');
        }
      });
    }

    // Auto-cargar Google Maps si hay una API key guardada
    try {
      const savedKey = localStorage.getItem('googleMapsApiKey');
      if (savedKey) {
        showToast('Detectada API Key. Cargando Google Maps...', 'info');
        await loadGoogleMapsSdk(savedKey);
        showToast('Google Maps activado automáticamente.', 'success');
      }
    } catch (err) {
      console.warn('No fue posible auto-cargar Google Maps:', err);
    }

    // Handler para gestionar zonas peligrosas
    document.getElementById('manageDangerousZonesBtn')?.addEventListener('click', () => {
      openDangerousZonesModal();
    });

    // Handler para asignar la ruta sugerida al domiciliario seleccionado
    const assignBtn = document.getElementById('assignRouteBtn');
    if (assignBtn) {
      assignBtn.addEventListener('click', async () => {
        const driverSelect = document.getElementById('routeDriverSelect');
        const maxPerRoute = document.getElementById('routeLimitSelect')?.value || 6;
        const driverId = driverSelect ? Number(driverSelect.value) : null;

        const activeDriversForAssign = Array.isArray(dashboardState.drivers)
          ? dashboardState.drivers.filter((driver) => Number(driver.active) === 1)
          : [];
        const suggestedRoutes = Array.isArray(dashboardState.routeSuggestion?.suggestedRoutes)
          ? dashboardState.routeSuggestion.suggestedRoutes
          : [];
        let displayedRoutesAssign = suggestedRoutes;
        if (activeDriversForAssign.length <= 1 && suggestedRoutes.length > 1) {
          const merged = suggestedRoutes.flatMap((route) => Array.isArray(route.orders) ? route.orders : []);
          const withCoords = merged.filter((order) => Number.isFinite(Number(order.latitude)) && Number.isFinite(Number(order.longitude)));
          const withoutCoords = merged.filter((order) => !(Number.isFinite(Number(order.latitude)) && Number.isFinite(Number(order.longitude))));
          withCoords.sort((a, b) => (Number(a.distKm || 0) - Number(b.distKm || 0)) || ((b.priorityScore || 0) - (a.priorityScore || 0)));
          withoutCoords.sort((a, b) => String(a.barrio || '').localeCompare(String(b.barrio || '')));
          displayedRoutesAssign = [{ id: 'route-1', label: 'Ruta única', orders: dedupeOrdersById([...withCoords, ...withoutCoords]) }];
        }

        const currentRoute = displayedRoutesAssign[dashboardState.selectedSuggestedRouteIndex];
        const sequence = currentRoute ? dedupeOrdersById(currentRoute.orders) : [];

        const routeSummary = dashboardState.routeOptimization ? {
          distanceKm: dashboardState.routeOptimization.distanceKm,
          durationMin: dashboardState.routeOptimization.durationMin,
          geometry: dashboardState.routeOptimization.geometry || null,
          source: dashboardState.routeOptimization.source || 'optimized'
        } : null;

        if (!driverId) {
          showToast('Selecciona un domiciliario antes de asignar la ruta.', 'error');
          return;
        }

        if (!sequence.length) {
          showToast('No hay pedidos disponibles para asignar.', 'error');
          return;
        }

        assignBtn.disabled = true;
        try {
          // Preparar puntos para optimizar (id + lat/lon)
          const points = sequence.map((o, idx) => {
            const coord = getRouteCoordinate(o, idx) || [];
            return { id: o.id, latitude: Number(o.latitude ?? coord[0] ?? 0), longitude: Number(o.longitude ?? coord[1] ?? 0) };
          }).filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

          let finalSequence = sequence;
          try {
            const depot = { latitude: 3.411568, longitude: -76.515763 };
            const opt = await request('/api/routes/optimize', { method: 'POST', body: JSON.stringify({ points, depot }) });
            if (opt && Array.isArray(opt.sequence) && opt.sequence.length) {
              const optimizedIds = opt.sequence.map(p => p.id).filter(id => id !== 'depot');
              const optimizedOrders = optimizedIds.map(id => sequence.find(s => String(s.id) === String(id))).filter(Boolean);
              if (optimizedOrders.length) finalSequence = optimizedOrders;
            }
          } catch (optErr) {
            console.warn('No se pudo optimizar vía OSRM, usando secuencia original.', optErr);
          }

          const orderIds = finalSequence.map(o => o.id).filter(Boolean);
          await request('/api/routes/assign', {
            method: 'POST',
            body: JSON.stringify({ driverId, orderIds, route: finalSequence, routeSummary, optimizationParams: { maxPerRoute, driverId: driverSelect.value } }) // Pass optimization parameters
          });
          deliveryRoutesHistory = [];
          showToast('Ruta asignada correctamente.', 'success');
          await refreshDashboard();
        } catch (err) {
          console.error('Error asignando ruta:', err);
          showToast(err.message || 'Error al asignar la ruta.', 'error');
        } finally {
          assignBtn.disabled = false;
        }
      });
    }

    // Handler para previsualizar la secuencia optimizada sin asignar
    const previewBtn = document.getElementById('previewOptimizeBtn');
    if (previewBtn) {
      previewBtn.addEventListener('click', async () => {
        // Recompute displayedRoutes same as renderRoutes to avoid mismatch
        const suggestedRoutes = dashboardState.routeSuggestion?.suggestedRoutes || [];
        const activeDriversForPreview = Array.isArray(dashboardState.drivers) ? dashboardState.drivers.filter((d) => Number(d.active) === 1) : [];
        let displayedRoutesPreview = suggestedRoutes;
        if (activeDriversForPreview.length <= 1 && suggestedRoutes.length > 1) {
          const merged = suggestedRoutes.flatMap(r => Array.isArray(r.orders) ? r.orders : []);
          const withCoords = merged.filter(o => Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude)));
          const withoutCoords = merged.filter(o => !(Number.isFinite(Number(o.latitude)) && Number.isFinite(Number(o.longitude))));
          withCoords.sort((a, b) => (Number(a.distKm || 0) - Number(b.distKm || 0)) || ((b.priorityScore || 0) - (a.priorityScore || 0)));
          withoutCoords.sort((a, b) => String(a.barrio || '').localeCompare(String(b.barrio || '')));
          displayedRoutesPreview = [{ id: 'route-1', label: 'Ruta única', orders: dedupeOrdersById([...withCoords, ...withoutCoords]) }];
        }
        const currentRoute = displayedRoutesPreview[dashboardState.selectedSuggestedRouteIndex];
        const sequence = currentRoute ? currentRoute.orders : [];

        if (!sequence.length) {
          showToast('No hay pedidos en la secuencia para optimizar.', 'error');
          return;
        }

        previewBtn.disabled = true;
        try {
          // Preparar puntos para optimizar (id + lat/lon)
          const points = sequence.map((o, idx) => {
            const coord = getRouteCoordinate(o, idx) || [];
            return { id: o.id, latitude: Number(o.latitude ?? coord[0] ?? 0), longitude: Number(o.longitude ?? coord[1] ?? 0) };
          }).filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

          console.log('PREVIEW: sequence length', sequence.length, 'points to send', points.length);
          console.log('PREVIEW points:', points);

          if (!points.length) {
            showToast('No se pudieron obtener coordenadas válidas para los pedidos.', 'error');
            return;
          }

          const depot = { latitude: 3.411568, longitude: -76.515763 };
          const opt = await request('/api/routes/optimize', { method: 'POST', body: JSON.stringify({ points, depot }) });

          if (!opt || !Array.isArray(opt.sequence)) {
            showToast('No se obtuvo una secuencia optimizada.', 'error');
            return;
          }

          // Mapear secuencia optimizada a objetos de pedido actuales, preservando lat/lon retornados por OSRM
          const optimizedOrders = opt.sequence.map((item) => {
            if (item.id === 'depot') return null;
            const found = sequence.find(s => String(s.id) === String(item.id));
            if (!found) return null;
            return Object.assign({}, found, { latitude: item.latitude ?? item.lat ?? found.latitude, longitude: item.longitude ?? item.lon ?? found.longitude });
          }).filter(Boolean);
          const uniqueOptimizedOrders = dedupeOrdersById(optimizedOrders);

          const previewSuggestion = JSON.parse(JSON.stringify(dashboardState.routeSuggestion));
          previewSuggestion.suggestedRoutes[dashboardState.selectedSuggestedRouteIndex].orders = uniqueOptimizedOrders;

          // DEBUG: registrar secuencia devuelta por el servidor y la que se pasará al render
          try {
            console.log('OPTIMIZE RESPONSE sequence:', opt.sequence);
            console.log('mapped optimizedOrders:', uniqueOptimizedOrders);
            console.log('previewSuggestion before render:', previewSuggestion.suggestedRoutes ? previewSuggestion.suggestedRoutes[dashboardState.selectedSuggestedRouteIndex] : null);
            showToast(`Optimizacion: servidor devolvio ${Array.isArray(opt.sequence) ? opt.sequence.length : 0} puntos, mapeados ${uniqueOptimizedOrders.length}`, 'info');
          } catch (e) { /* ignore */ }

          if (opt.geometry) previewSuggestion.geometry = opt.geometry;

          dashboardState.routeOptimization = opt;

          // Actualizar indicadores de distancia/eta si vienen
          const distanceNode = document.getElementById('routeDistance');
          const etaNode = document.getElementById('routeEta');
          if (distanceNode && opt.distanceKm != null) distanceNode.textContent = `${(opt.distanceKm).toFixed(1)} km`;
          if (etaNode && opt.durationMin != null) etaNode.textContent = `${opt.durationMin} min`;

          renderRoutes(previewSuggestion, dashboardState.drivers);
          showToast('Previsualización optimizada cargada.', 'success');
        } catch (err) {
          console.error('Error previsualizando optimización:', err);
          showToast('Error al obtener la secuencia optimizada.', 'error');
        } finally {
          previewBtn.disabled = false;
        }
      });
    }

    document.getElementById('driversList')?.addEventListener('click', async (event) => {
      const toggleBtn = event.target.closest('[data-driver-toggle]');
      const editBtn = event.target.closest('[data-driver-edit]');
      const deleteBtn = event.target.closest('[data-driver-delete]');

      if (toggleBtn) {
        const driverId = toggleBtn.dataset.driverToggle;
        const isActivating = toggleBtn.dataset.active === '1';
        showToast(`Domiciliario ${isActivating ? 'activado' : 'desactivado'}`, 'info');
        await request(`/api/drivers/${driverId}/active`, {
          method: 'PATCH',
          body: JSON.stringify({ active: isActivating })
        });
        await refreshDashboard();
        return;
      }

      if (editBtn) {
        const driver = dashboardState.drivers.find((item) => Number(item.id) === Number(editBtn.dataset.driverEdit));
        if (driver) openDriverModal(driver);
        return;
      }

      if (deleteBtn) {
        const deleteId = deleteBtn.dataset.driverDelete;
        showModal({
          title: '¿Eliminar domiciliario?',
          body: 'Esta acción no se puede deshacer.',
          confirmText: 'Eliminar',
          cancelText: 'Cancelar',
          onConfirm: async () => {
            try {
              await request(`/api/drivers/${deleteId}`, { method: 'DELETE' });
              showToast('Domiciliario eliminado', 'success');
              await refreshDashboard();
            } catch (error) {
              showToast(error.message, 'error');
            }
          }
        });
      }
    });

    // Event listeners para productos
    document.getElementById('productsList')?.addEventListener('click', async (event) => {
      const toggleBtn = event.target.closest('[data-product-toggle]');
      const editBtn = event.target.closest('[data-product-edit]');
      const deleteBtn = event.target.closest('[data-product-delete]');

      if (toggleBtn) {
        const productId = toggleBtn.dataset.productToggle;
        const isActivating = toggleBtn.dataset.active === '1';
        showToast(`Producto ${isActivating ? 'activado' : 'desactivado'}`, 'info');
        await request(`/api/products/${productId}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: isActivating })
        });
        await refreshDashboard();
      } else if (editBtn) {
        const product = dashboardState.products.find(p => Number(p.id) === Number(editBtn.dataset.productEdit));
        if (product) openProductModal(product);
      } else if (deleteBtn) {
        const deleteId = deleteBtn.dataset.productDelete;
        showModal({
          title: '¿Eliminar producto?',
          body: 'Esta acción no se puede deshacer.',
          confirmText: 'Eliminar',
          cancelText: 'Cancelar',
          onConfirm: async () => {
            try {
              await request(`/api/products/${deleteId}`, { method: 'DELETE' });
              showToast('Producto eliminado', 'success');
              await refreshDashboard();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        });
      }
    });

    document.getElementById('statsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = getFormData(event.currentTarget);
      const cutoffHour = formData.cutoffHour || 0; // Cutoff at midnight for daily reset
      const stats = await request(`/api/stats?range=${encodeURIComponent(formData.range)}&cutoffHour=${encodeURIComponent(cutoffHour)}`);
      renderStats(stats);
    });

    const closePanelBtn = document.getElementById('closeOrderPanel');
    if (closePanelBtn) closePanelBtn.addEventListener('click', closeOrderPanel);

    // Event listener for order status changes
    document.getElementById('ordersList').addEventListener('change', async (event) => {
      if (event.target.classList.contains('status-changer')) {
        const orderId = event.target.dataset.orderId;
        const newStatus = event.target.value;
        try {
          await request(`/api/orders/${orderId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: newStatus })
          });
          showToast(`Pedido #${orderId} actualizado a "${newStatus}"`, 'success');
          await refreshDashboard(); // Refresh to show updated status and stats
        } catch (error) {
          console.error('Error al actualizar estado del pedido:', error);
          showToast('Error: ' + error.message, 'error');
        }
      }
    });

    // Lógica de filtros (pills) para la tabla de comandas
    document.querySelectorAll('.filter-pill[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const newFilter = btn.dataset.filter;
        if (ordersTableState.filter !== newFilter) {
          document.querySelectorAll('.filter-pill[data-filter]').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');

          ordersTableState.filter = newFilter;
          ordersTableState.page = 1;
          renderOrders(dashboardState.orders);
        }
      });
    });

    // Buscador de pedidos por ID en tiempo real
    document.getElementById('orderSearchInput').addEventListener('input', (e) => {
      ordersTableState.searchTerm = e.target.value;
      ordersTableState.page = 1;
      renderOrders(dashboardState.orders);
    });

    // Eventos de la vista de clientes
    document.getElementById('clientViewSearch')?.addEventListener('input', (e) => {
      clientsTableState.searchTerm = e.target.value;
      renderClients();
    });

    document.getElementById('driverSearchInput')?.addEventListener('input', (e) => {
      driversTableState.searchTerm = e.target.value;
      renderDrivers(dashboardState.drivers);
    });

    document.getElementById('openClientModalBtn')?.addEventListener('click', () => {
      openClientModal();
    });

    document.getElementById('editClientDetailBtn')?.addEventListener('click', () => {
      const client = dashboardState.clients.find(c => Number(c.id) === Number(clientsTableState.selectedId));
      if (client) openClientModal(client);
    });

    document.getElementById('deleteClientDetailBtn')?.addEventListener('click', () => {
      const id = clientsTableState.selectedId;
      if (!id) return;
      showModal({
        title: '¿Eliminar cliente?',
        body: 'Se eliminará el cliente y su historial de direcciones. Esta acción no se puede deshacer.',
        confirmText: 'Eliminar',
        onConfirm: async () => {
          try {
            await request(`/api/clients/${id}`, { method: 'DELETE' });
            showToast('Cliente eliminado', 'success');
            clientsTableState.selectedId = null;
            await refreshDashboard();
          } catch (e) { showToast(e.message, 'error'); }
        }
      });
    });

    document.getElementById('productSearchInput')?.addEventListener('input', (e) => {
      productsTableState.searchTerm = e.target.value;
      renderProducts(dashboardState.products);
    });

    document.getElementById('routeHistorySearchInput')?.addEventListener('input', (e) => {
      // Trigger re-render of history with search term
      renderDeliveryRoutesHistory();
    });

    document.getElementById('dailyClosuresSearchInput')?.addEventListener('input', () => {
      renderDailyClosures();
    });

    // Auto-refresco desactivado: el usuario refresca manualmente con el botón/acciones de la UI.

  }

  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => {
      const status = document.getElementById('serverStatus');
      const msg = document.getElementById('orderMessage');
      if (status) status.textContent = 'Error al iniciar';
      if (msg) msg.textContent = error.message;
    });
  });
