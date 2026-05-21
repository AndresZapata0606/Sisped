const baseUrl = window.location.origin;
const pendingItems = [];
let productsViewFilter = 'all';
let routeMapInstance = null;
let routeLayerGroup = null;
let googleMapInstance = null;
let googleMarkers = [];
let googlePolyline = null;
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
const productsTableState = {
  searchTerm: ''
};
// currently selected order id in the table
ordersTableState.selectedId = null;

const caliNeighborhoodCenters = {
  'san fernando': [3.4392, -76.5486],
  tequendama: [3.4297, -76.5402],
  granada: [3.4512, -76.5331],
  centro: [3.4516, -76.5320],
  sur: [3.4085, -76.5400],
  norte: [3.4870, -76.5280],
  oeste: [3.4590, -76.5530],
  'belen': [3.4024, -76.5426],
  'prados del norte': [3.4868, -76.5178]
};

function hashString(value) {
  return String(value || '').split('').reduce((accumulator, character) => ((accumulator << 5) - accumulator) + character.charCodeAt(0), 0);
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

  // Fallback heurístico por barrio
  const key = String(order.barrio || order.route_zone || '').toLowerCase().trim();
  const base = caliNeighborhoodCenters[key] || [3.4516, -76.5320];
  const offsetSeed = hashString(`${order.address || ''}-${order.id}-${index}`);
  const latOffset = ((offsetSeed % 7) - 3) * 0.0012;
  const lngOffset = (((offsetSeed >> 3) % 7) - 3) * 0.0012;

  return [base[0] + latOffset, base[1] + lngOffset];
}

function formatRouteTitle(value) {
  if (value === 'all') return 'Todos los pedidos listos';
  if (value === 'available') return 'Pedidos listos para despacho';
  return 'Rutas activas';
}

function wireSidebarNavigation() {
  const navItems = Array.from(document.querySelectorAll('[data-target]'));
  const sidebarToggle = document.getElementById('sidebarToggle');

  function setActiveView(viewName) {
    document.querySelectorAll('[data-view]').forEach((panel) => {
      panel.classList.toggle('active-view', panel.dataset.view === viewName);
    });

    navItems.forEach((nav) => nav.classList.toggle('active', nav.dataset.target === viewName));

    const selectedPanel = document.querySelector(`[data-view="${viewName}"]`);
    if (selectedPanel) {
      selectedPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // If switching to orders view, re-render orders table
    if (viewName === 'orders') {
      try {
        renderOrders(dashboardState.orders || []);
      } catch (e) {
        console.warn('Error rendering orders on view switch', e);
      }
    }

    if (viewName === 'clients') {
      renderClients();
    }

    if (viewName === 'catalog') {
      renderProducts(dashboardState.products);
    }

    if (viewName === 'drivers') {
      renderDrivers(dashboardState.drivers);
    }

    if (window.innerWidth <= 840) {
      document.body.classList.remove('sidebar-open');
    }
  }

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      setActiveView(item.dataset.target);
    });
  });

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
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

function money(value) {
  return copFormatter.format(Number(value || 0));
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
    throw new Error(payload.message || 'La solicitud fallo.');
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

    // Sincronización con el formulario: ocultamos el input original y usamos el nuevo
    // Pero mantenemos el original oculto para que FormData siga funcionando sin cambios.
    addressInput.style.display = 'none';
    addressInput.required = false; // Evita el error "An invalid form control is not focusable"

    addressInput.insertAdjacentElement('afterend', autocompleteEl);

    // Placeholder modernizado
    autocompleteEl.classList.add('modern-autocomplete');

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
      barrioInput.value = '';
      const latInp = container.querySelector('[name="latitude"]');
      const lonInp = container.querySelector('[name="longitude"]');
      if (latInp) latInp.value = '';
      if (lonInp) lonInp.value = '';
    });

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
      addressInput.value = place.displayName || '';
      barrioInput.value = barrio || 'Cali'; // Fallback a ciudad si no hay barrio

      if (barrio) showToast(`Ubicación confirmada en ${barrio}`, 'success');

      // Guardar coordenadas ocultas si el formulario lo soporta
      const latInput = container.querySelector('[name="latitude"]');
      const lonInput = container.querySelector('[name="longitude"]');
      if (latInput) latInput.value = lat;
      if (lonInput) lonInput.value = lng;

      // Actualizar visualización del mapa
      updateMiniMap(lat, lng);
    });

    return; // Salimos, ya no necesitamos el polling manual
  }
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

function showModal({ title, body, confirmText = 'Aceptar', cancelText = 'Cancelar', onConfirm, onCancel, isWide = false }) {
  const overlay = document.getElementById('modalOverlay');
  const content = overlay.querySelector('.modal-content');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const footerEl = document.getElementById('modalFooter');

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  footerEl.innerHTML = '';

  content.classList.toggle('wide', isWide);

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
    btnConfirm.onclick = () => {
      overlay.classList.remove('active');
      if (onConfirm) onConfirm();
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
        footerSubmit.className = 'primary';
        footerSubmit.textContent = 'Guardar';
        footerSubmit.onclick = () => {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        };
        footerEl.appendChild(footerSubmit);
      }
    }
  }

  overlay.classList.add('active');
}

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
    isWide: true
  });

  queueMicrotask(() => {
    const modalBody = document.querySelector('.modal-body');
    if (typeof attachOrderFormEvents === 'function') attachOrderFormEvents(modalBody, order);
    if (typeof renderPendingItemsInModal === 'function') renderPendingItemsInModal();

    const clearBtn = modalBody.querySelector('#clearOrderForm');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      const form = modalBody.querySelector('#orderForm');
      if (!form) return;
      form.reset();
      pendingItems.length = 0;
      renderPendingItemsInModal();
    });
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

    container.innerHTML = orders.map(o => `
      <div class="row" style="margin-bottom: 8px;">
        <div style="display:flex; justify-content:space-between;">
          <strong>Pedido #${o.id}</strong>
          <span class="meta">${new Date(o.created_at.replace(' ', 'T')).toLocaleDateString()}</span>
        </div>
        <div class="meta">${o.status.toUpperCase()} · ${money(o.total)}</div>
        <div class="subtle" style="font-size: 0.75rem;">
          ${(o.items || []).map(i => `${i.name_snapshot} x${i.quantity}`).join(', ')}
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Error al cargar historial del cliente:', e);
    container.innerHTML = `
      <div class="error" style="color: var(--danger); font-size: 0.85rem;">
        Error al cargar historial: ${e.message}
      </div>`;
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
      <td style="text-align:right;"><strong>${c.address_count || 0}</strong> direcciones</td>
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
  const body = document.getElementById('clientDetailBody');
  const actions = document.getElementById('clientDetailActions');
  if (!body) return;

  // Cargar direcciones adicionales del cliente
  let addresses = [];
  try {
    addresses = await request(`/api/clients/${client.id}/addresses`);
  } catch (e) { console.error(e); }

  body.innerHTML = `
    <div style="text-align:center; margin-bottom:10px;">
      <div style="width:64px; height:64px; background:rgba(245,158,11,0.1); color:var(--accent); border-radius:50%; display:flex; align-items:center; justify-content:center; margin:0 auto 12px; font-size:24px; font-weight:800;">
        ${client.name.charAt(0)}
      </div>
      <h4 style="font-size:18px; margin:0;">${escapeHtml(client.name)}</h4>
      <div class="subtle">${escapeHtml(client.phone)}</div>
    </div>
    
    <div style="display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <div style="font-size:11px; text-transform:uppercase; color:var(--muted); font-weight:700;">Direcciones Guardadas</div>
        <button id="addAddressBtn" style="background:none; border:none; color:var(--accent); cursor:pointer; font-size:11px; font-weight:700; display:flex; align-items:center; gap:4px;">
          <span class="material-symbols-rounded" style="font-size:16px;">add_location</span> Agregar
        </button>
      </div>
      ${addresses.map(addr => `
        <div class="address-card" style="background:rgba(255,255,255,0.03); padding:12px; border-radius:12px; border:1px solid ${addr.is_primary ? 'rgba(245,158,11,0.4)' : 'var(--panel-border)'};">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
            <span style="font-size:10px; font-weight:800; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">
              ${escapeHtml(addr.label)} ${addr.is_primary ? '<span style="color:var(--accent); margin-left:4px;">★ Principal</span>' : ''}
            </span>
            <div style="display:flex; gap:8px;">
              <button class="address-action-btn" data-action="edit" data-id="${addr.id}" title="Editar" style="background:none; border:none; color:var(--muted); cursor:pointer; padding:0;">
                <span class="material-symbols-rounded" style="font-size:16px;">edit</span>
              </button>
              ${!addr.is_primary ? `
                <button class="address-action-btn" data-action="delete" data-id="${addr.id}" title="Eliminar" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:0;">
                  <span class="material-symbols-rounded" style="font-size:16px;">delete</span>
                </button>
              ` : ''}
            </div>
          </div>
          <div style="font-size:13px; font-weight:600; color:var(--text-primary);">${escapeHtml(addr.address)}</div>
          <div class="subtle" style="font-size:12px; margin-top:2px;">${escapeHtml(addr.barrio)}</div>
          ${addr.reference ? `<div class="subtle" style="font-size:11px; font-style:italic; margin-top:4px;">"${escapeHtml(addr.reference)}"</div>` : ''}
          ${!addr.is_primary ? `
            <button class="address-action-btn" data-action="set-primary" data-id="${addr.id}" style="width:100%; margin-top:8px; background:rgba(255,255,255,0.05); border:1px solid var(--panel-border); border-radius:8px; padding:4px; font-size:10px; color:var(--muted); cursor:pointer;">Marcar como principal</button>
          ` : ''}
        </div>
      `).join('')}
    </div>

    <div style="margin-top:10px;">
      <div style="font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;">Notas Internas</div>
      <div style="font-size:12px; font-style:italic; color:var(--text-secondary);">${escapeHtml(client.notes || 'Sin notas registradas')}</div>
    </div>

    <div id="clientSidebarHistory" style="margin-top:10px;">
      <div style="font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;">Historial Reciente</div>
      <div class="mini-list" id="clientHistoryList">Cargando...</div>
    </div>
  `;

  if (actions) actions.style.display = 'block';
  renderClientHistory(client.id, document.getElementById('clientHistoryList'));

  // Asignar eventos a las acciones de direcciones
  const addBtn = body.querySelector('#addAddressBtn');
  if (addBtn) addBtn.onclick = () => openAddressModal(client.id);

  body.querySelectorAll('.address-action-btn').forEach(btn => {
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
      </div>
      <div class="stack-form">
        <label class="subtle">Referencia / Detalle</label>
        <input name="reference" type="text" value="${escapeHtml(address?.reference || '')}" placeholder="Apto, Casa color azul, etc." />
      </div>
    </form>
    <div class="mini-map-preview"></div>
  `;

  showModal({
    title: address ? 'Editar Dirección' : 'Agregar Nueva Dirección',
    body,
    confirmText: 'Guardar Dirección',
    cancelText: 'Cancelar',
    onConfirm: async () => {
      const form = document.getElementById('addressForm');
      const data = getFormData(form);
      try {
        if (address) {
          await request(`/api/addresses/${address.id}`, { method: 'PATCH', body: JSON.stringify(data) });
        } else {
          await request(`/api/clients/${clientId}/addresses`, { method: 'POST', body: JSON.stringify(data) });
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
  attachGeocoding(document.getElementById('modalBody'));
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
    filtered = filtered.filter(p => p.name.toLowerCase().includes(term) || p.category.toLowerCase().includes(term));
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

  const getGroupMarkup = (title, items, emptyMessage) => `
    <section class="product-group">
      <div class="product-group-header">
        <div>
          <h3>${title}</h3>
          <p>${items.length} producto(s)</p>
        </div>
      </div>
      <div class="product-group-list">
        ${items.length ? items.map(getProductCard).join('') : `<div class="product-group-empty">${emptyMessage}</div>`}
      </div>
    </section>
  `;

  const comboProducts = filtered.filter((product) => parseComboItems(product.combo_items).length > 0 || String(product.category || '').toLowerCase().includes('combo'));
  const individualProducts = filtered.filter((product) => !parseComboItems(product.combo_items).length && !String(product.category || '').toLowerCase().includes('combo'));
  const sections = {
    all: [
      getGroupMarkup('Productos individuales', individualProducts, 'No hay productos individuales que coincidan.'),
      getGroupMarkup('Combos', comboProducts, 'No hay combos que coincidan.')
    ],
    individuals: [getGroupMarkup('Productos individuales', individualProducts, 'No hay productos individuales registrados.')],
    combos: [getGroupMarkup('Combos', comboProducts, 'No hay combos registrados.')]
  };

  if (container) {
    container.innerHTML = sections[productsViewFilter].join('');
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
        <div class="stack-form">
          <label class="subtle">Zona / barrio</label>
          <input name="zone" type="text" placeholder="Sur, Norte, Centro..." value="${escapeHtml(driver?.zone || '')}" />
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
              zone: data.zone,
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
              zone: data.zone,
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
  const orderDriverSelect = document.getElementById('orderDriverSelect');

  // Actualizar KPIs de domiciliarios (Estilo SaaS)
  const kpiTotal = document.getElementById('kpiTotalDrivers');
  const kpiActive = document.getElementById('kpiActiveDrivers');
  const kpiOnRoute = document.getElementById('kpiOnRouteDrivers');

  if (kpiTotal) kpiTotal.textContent = drivers.length;
  if (kpiActive) kpiActive.textContent = drivers.filter(d => Number(d.active) === 1).length;
  if (kpiOnRoute) kpiOnRoute.textContent = drivers.filter(d => String(d.current_status) === 'en ruta').length;

  const activeDrivers = drivers.filter((d) => Number(d.active) === 1);
  const inactiveDrivers = drivers.filter((d) => Number(d.active) !== 1);

  // Actualizar selector en la comanda
  if (orderDriverSelect) {
    orderDriverSelect.innerHTML = '<option value="">Sin asignar (despacho manual)</option>' +
      activeDrivers.map(d => `<option value="${d.id}">${d.name} (${d.zone || 'Sin zona'})</option>`).join('');
  }

  if (container) {
    const renderDriverCard = (driver) => `
      <article class="driver-card" data-active="${driver.active ? '1' : '0'}">
        <div class="driver-card-top">
          <div>
            <div class="driver-card-title-row">
              <h4>${escapeHtml(driver.name)}</h4>
              <span class="driver-state ${driver.active ? 'is-active' : 'is-inactive'}">${driver.active ? 'Activo' : 'Inactivo'}</span>
            </div>
            <div class="driver-card-meta">${escapeHtml(driver.vehicle)} · ${escapeHtml(driver.zone || 'Sin zona')}</div>
          </div>
          <div class="driver-card-badge">${escapeHtml(driver.current_status || 'disponible')}</div>
        </div>

        <div class="driver-card-body">
          <div class="driver-detail-label">Datos de contacto</div>
          <p>${escapeHtml(driver.phone || 'Sin teléfono')}</p>
        </div>

        <div class="driver-card-actions">
          <button type="button" data-driver-toggle="${driver.id}" data-active="${driver.active ? '0' : '1'}" class="mini-action toggle ${driver.active ? 'active' : ''}">${driver.active ? 'Desactivar' : 'Activar'}</button>
          <button type="button" data-driver-edit="${driver.id}" class="mini-action edit">Editar</button>
          <button type="button" data-driver-delete="${driver.id}" class="mini-action danger">Eliminar</button>
        </div>
      </article>
    `;

    container.innerHTML = `
      <section class="driver-group">
        <div class="driver-group-header">
          <div>
            <h3>Activos</h3>
            <p>${activeDrivers.length} domiciliario(s)</p>
          </div>
        </div>
        <div class="driver-group-list">
          ${activeDrivers.length ? activeDrivers.map(renderDriverCard).join('') : '<div class="product-group-empty">No hay domiciliarios activos.</div>'}
        </div>
      </section>
      <section class="driver-group">
        <div class="driver-group-header">
          <div>
            <h3>Inactivos</h3>
            <p>${inactiveDrivers.length} domiciliario(s)</p>
          </div>
        </div>
        <div class="driver-group-list">
          ${inactiveDrivers.length ? inactiveDrivers.map(renderDriverCard).join('') : '<div class="product-group-empty">No hay domiciliarios inactivos.</div>'}
        </div>
      </section>
    `;
  }
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

  container.innerHTML = itemsHtml + `
    <div class="row" style="border-top: 2px solid var(--accent); margin-top: 10px; background: rgba(245, 158, 11, 0.05);">
      <strong>Total de la comanda</strong>
      <div class="meta" style="font-size: 1.2rem; color: var(--accent); font-weight: bold;">${money(total)}</div>
    </div>
  `;
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
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
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
        <span class="subtle">${new Date(order.created_at).toLocaleString('es-CO')}</span>
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
  const pageItems = filtered.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(start, start + pageSize);

  // build table rows
  tbody.innerHTML = pageItems.map(o => `
    <tr class="orders-row" data-order-id="${o.id}">
      <td class="col-id">#${o.id}</td>
      <td class="col-client"><div class="client-name">${escapeHtml(o.client_name)}</div><div class="subtle client-phone">${escapeHtml(o.client_phone || '')}</div></td>
      <td class="col-address"><div class="subtle">${escapeHtml(o.barrio || '')} · ${escapeHtml(o.address || '')}</div></td>
      <td class="col-status"><span class="order-status-badge ${getOrderStatusClass(o.status)}">${escapeHtml(o.status || '')}</span></td>
      <td class="col-total"><strong>${money(o.total)}</strong></td>
      <td class="col-time"><div class="subtle">${new Date(o.created_at).toLocaleTimeString('es-CO')}</div></td>
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
  const items = document.getElementById('detailItems'); if (items) {
    const list = (order.items || []).map(i => `<div style="display:flex;justify-content:space-between; padding:6px 0;"> <div>${escapeHtml(i.name_snapshot || i.name || 'Item')}</div><div class="subtle">x${i.quantity}</div></div>`).join('') || '<div class="subtle">Sin items</div>';
    items.innerHTML = `<div class="subtle">Resumen del pedido</div><div>${list}</div>`;
  }
  const totalNode = document.getElementById('detailTotal'); if (totalNode) totalNode.textContent = money(order.total || 0);
  const statusBadge = document.getElementById('detailStatusBadge'); if (statusBadge) {
    statusBadge.textContent = (order.status || '').toUpperCase();
    // adjust classes
    statusBadge.className = 'insight-chip ' + (order.status && String(order.status).toLowerCase().includes('entreg') ? 'success' : (order.status && String(order.status).toLowerCase().includes('ruta') ? 'neutral' : ''));
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
  const summaryContainer = document.getElementById('statsSummaryBanner');
  const container = document.getElementById('statsCards');
  const trendContainer = document.getElementById('statsTrend');
  const rangeLabels = {
    day: 'Día',
    week: 'Semana',
    month: 'Mes'
  };

  const statusCounts = dashboardState.orders.reduce((accumulator, order) => {
    const key = String(order.status || 'nuevo').toLowerCase();
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  const statusRows = [
    { key: 'nuevo', label: 'Nuevos', colorClass: 'fill-0' },
    { key: 'en preparación', label: 'En preparación', colorClass: 'fill-1' },
    { key: 'listo para salir', label: 'Listos para salir', colorClass: 'fill-2' },
    { key: 'en ruta', label: 'En ruta', colorClass: 'fill-0' },
    { key: 'entregado', label: 'Entregados', colorClass: 'fill-1' },
    { key: 'cancelado', label: 'Cancelados', colorClass: 'fill-2' }
  ];

  const maxStatusCount = Math.max(...statusRows.map((row) => statusCounts[row.key] || 0), 1);

  if (summaryContainer) {
    summaryContainer.innerHTML = `
      <div class="stats-summary-main">
        <div>
          <p class="eyebrow">Resumen del período</p>
          <h3>${rangeLabels[String(stats.range || 'day')] || stats.range}</h3>
          <p>${stats.totalOrders} pedidos procesados · ${money(stats.totalSales)} en ventas · corte ${document.querySelector('#statsForm [name="cutoffHour"]')?.value || 20}:00</p>
        </div>
        <div class="stats-summary-highlight">
          <span>Ticket promedio</span>
          <strong>${money(stats.averageTicket)}</strong>
          <small>${(stats.averageDeliveryTimeMinutes || 0).toFixed(0)} min de entrega</small>
        </div>
      </div>
      <div class="stats-summary-pulse">
        <span class="pulse-dot"></span>
        <span>${stats.deliveredOrders} entregados, ${stats.cancelledOrders} cancelados, ${stats.topProduct} lidera el período.</span>
      </div>
    `;
  }

  if (container) {
    container.innerHTML = `
      <article class="stat stat-hero">
        <span>Pedidos totales</span>
        <strong>${stats.totalOrders}</strong>
        <p>En el período seleccionado</p>
      </article>
      <article class="stat stat-accent">
        <span>Ventas totales</span>
        <strong>${money(stats.totalSales)}</strong>
        <p>Ingreso acumulado</p>
      </article>
      <article class="stat">
        <span>Pedidos entregados</span>
        <strong>${stats.deliveredOrders}</strong>
        <p>Comandas cerradas</p>
      </article>
      <article class="stat">
        <span>Pedidos cancelados</span>
        <strong>${stats.cancelledOrders}</strong>
        <p>Con incidencia</p>
      </article>
      <article class="stat">
        <span>Ticket promedio</span>
        <strong>${money(stats.averageTicket)}</strong>
        <p>Valor medio por pedido</p>
      </article>
      <article class="stat">
        <span>Tiempo promedio</span>
        <strong>${(stats.averageDeliveryTimeMinutes || 0).toFixed(0)} min</strong>
        <p>Desde salida hasta entrega</p>
      </article>
      <article class="stat">
        <span>Producto más vendido</span>
        <strong>${stats.topProduct}</strong>
        <p>${stats.topProductCount || 0} unidades</p>
      </article>
      <article class="stat">
        <span>Domiciliario líder</span>
        <strong>${stats.topDriver}</strong>
        <p>Mayor cantidad de pedidos</p>
      </article>
    `;
  }

  if (trendContainer) {
    trendContainer.innerHTML = `
      <div class="stats-trend-list">
        ${statusRows.map((row) => {
      const count = statusCounts[row.key] || 0;
      const width = `${Math.max((count / maxStatusCount) * 100, 8)}%`;
      return `
            <div class="stats-trend-row">
              <div class="stats-trend-label">
                <span class="dot ${row.colorClass}"></span>
                <span>${row.label}</span>
              </div>
              <div class="stats-trend-track"><div class="stats-trend-fill ${row.colorClass}" style="width:${width}"></div></div>
              <strong>${count}</strong>
            </div>
          `;
    }).join('')}
      </div>
      <div class="stats-trend-foot">
        <div>
          <span>Rango consultado</span>
          <strong>${rangeLabels[String(stats.range || 'day')] || stats.range}</strong>
        </div>
        <div>
          <span>Top estado</span>
          <strong>${Object.entries(statusCounts).sort((left, right) => right[1] - left[1])[0]?.[0] || 'Sin datos'}</strong>
        </div>
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
      zone: driver.zone || 'Sin zona',
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
  const elTopDriverMeta = getEl('topDriverMeta'); if (elTopDriverMeta) elTopDriverMeta.textContent = topDriver ? `${topDriver.zone} · ${topDriver.total} pedidos asignados` : 'Se actualiza con la operación diaria.';
  const elTopDriverOrders = getEl('topDriverOrders'); if (elTopDriverOrders) elTopDriverOrders.textContent = topDriver ? `${topDriver.total} pedidos` : '0 pedidos';
  const elTopDriverZone = getEl('topDriverZone'); if (elTopDriverZone) elTopDriverZone.textContent = topDriver ? topDriver.zone : 'Sin zona';

  const elTopProductName = getEl('topProductName'); if (elTopProductName) elTopProductName.textContent = stats ? stats.topProduct : 'Sin datos';
  const elTopProductMeta = getEl('topProductMeta'); if (elTopProductMeta) elTopProductMeta.textContent = stats && stats.topProduct !== 'Sin datos' ? `El producto más vendido en el rango.` : 'Todavía no hay suficiente historial.';
  const elTopProductCount = getEl('topProductCount'); if (elTopProductCount) elTopProductCount.textContent = stats && stats.topProduct !== 'Sin datos' ? `${stats.topProductCount || 0} unidades` : '0 unidades';

  const elTopStatusName = getEl('topStatusName'); if (elTopStatusName) elTopStatusName.textContent = topStatus[0];
  const elTopStatusMeta = getEl('topStatusMeta'); if (elTopStatusMeta) elTopStatusMeta.textContent = `${topStatus[1]} pedidos dentro del estado dominante.`;
  const elTopStatusCount = getEl('topStatusCount'); if (elTopStatusCount) elTopStatusCount.textContent = `${topStatus[1]} pedidos`;
  const elTopStatusHint = getEl('topStatusHint'); if (elTopStatusHint) elTopStatusHint.textContent = topStatus[1] > 0 ? 'Lectura rápida del día' : 'Sin actividad dominante';
}

async function refreshDashboard() {
  const cutoffHour = document.querySelector('#statsForm [name="cutoffHour"]')?.value || 20;
  const routeDriverId = document.getElementById('routeDriverSelect')?.value || '';
  const maxPerRoute = document.getElementById('routeLimitSelect')?.value || 5;

  const [products, drivers, orders, clients, stats] = await Promise.all([
    request('/api/products'),
    request('/api/drivers'),
    request('/api/orders'),
    request('/api/clients'),
    request(`/api/stats?range=day&cutoffHour=${cutoffHour}`)
  ]);

  const routeSuggestion = await request(`/api/routes/suggest?driverId=${encodeURIComponent(routeDriverId)}&maxPerRoute=${maxPerRoute}`);

  dashboardState.products = products;
  dashboardState.drivers = drivers;
  dashboardState.orders = orders;
  dashboardState.clients = clients;
  dashboardState.stats = stats;
  dashboardState.routeSuggestion = routeSuggestion;

  renderProducts(products);
  renderDrivers(drivers);

  // Renderizado centralizado: renderOrders ya utiliza el estado de búsqueda y filtros
  renderOrders(dashboardState.orders);

  renderPendingItems();
  renderStats(stats);
  renderOverviewKpis();
  renderOverviewInsights();
  renderOrdersChart();

  if (routeSuggestion.suggestedRoutes && dashboardState.selectedSuggestedRouteIndex >= routeSuggestion.suggestedRoutes.length) {
    dashboardState.selectedSuggestedRouteIndex = 0;
  }
  renderRoutes(routeSuggestion, drivers);
  document.getElementById('serverStatus').textContent = 'Servidor local activo';
}

function renderRoutes(routeSuggestion, drivers) {
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
      ${activeDrivers.map((driver) => `<option value="${driver.id}">${escapeHtml(driver.name)} · ${escapeHtml(driver.zone || 'Sin zona')}</option>`).join('')}
    `;
    if (currentValue) {
      driverSelect.value = currentValue;
    }
  }

  const suggestedRoutes = Array.isArray(routeSuggestion?.suggestedRoutes) ? routeSuggestion.suggestedRoutes : [];
  const selectedIndex = dashboardState.selectedSuggestedRouteIndex || 0;
  const currentRoute = suggestedRoutes[selectedIndex] || null;
  const sequence = currentRoute ? currentRoute.orders : [];

  const allOrdersReady = suggestedRoutes.reduce((acc, r) => acc + r.orders.length, 0);
  const zonesCount = new Set(suggestedRoutes.map(r => r.zone)).size;

  if (orderCount) {
    orderCount.textContent = String(allOrdersReady);
  }

  if (neighborhoodCount) {
    neighborhoodCount.textContent = String(zonesCount);
  }

  if (distanceNode) {
    const estimatedDistance = Math.max(allOrdersReady * 1.8, zonesCount * 2.4, allOrdersReady ? 2 : 0);
    distanceNode.textContent = `${estimatedDistance.toFixed(1)} KM`;
  }

  if (etaNode) {
    const estimatedMinutes = Math.max(allOrdersReady * 8 + zonesCount * 6, 0);
    if (etaNode) etaNode.textContent = `${estimatedMinutes} MIN`;
  }

  // Renderizar tarjetas de rutas sugeridas
  if (routesListContainer) {
    routesListContainer.innerHTML = suggestedRoutes.length
      ? suggestedRoutes.map((route, idx) => `
        <div class="insight-card ${idx === selectedIndex ? 'selected-route' : ''}" 
             style="padding: 12px; cursor: pointer; border: 1px solid ${idx === selectedIndex ? 'var(--accent)' : 'var(--panel-border)'}; 
                    background: ${idx === selectedIndex ? 'rgba(245,158,11,0.05)' : 'rgba(0,0,0,0.15)'}; min-height: auto;"
             data-route-idx="${idx}">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong style="font-size: 14px; margin: 0;">${escapeHtml(route.zone)}</strong>
            <span class="insight-chip success" style="font-size: 10px;">${route.orders.length} pedidos</span>
          </div>
          <p style="font-size: 11px; margin-top: 4px;">Ruta #${idx + 1}</p>
        </div>
      `).join('')
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
      title.innerHTML = `Secuencia: <span style="color:var(--accent)">${escapeHtml(currentRoute.zone)}</span>`;
    }
    sequenceContainer.innerHTML = sequence.length
      ? sequence.map((order, index) => `
        <article class="route-stop" style="background: rgba(15, 23, 42, 0.6); border: 1px solid var(--panel-border); margin-bottom: 8px;">
          <div class="route-stop-index">${index + 1}</div>
          <div class="route-stop-body">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
              <strong style="font-size: 14px;">${escapeHtml(order.client_name || `Pedido #${order.id}`)}</strong>
              <span style="font-size: 12px; font-weight: 800; color: var(--accent);">${money(order.total)}</span>
            </div>
            <p style="font-size: 12px; margin: 4px 0;">${escapeHtml(order.address || 'Sin dirección')}</p>
            <div class="subtle" style="font-size: 11px; margin-top: 4px; color: var(--accent);">
              📦 ${(order.items || []).map(i => `${i.quantity}x ${escapeHtml(i.name_snapshot)}`).join(', ') || 'Sin productos'}
            </div>
            ${Number.isFinite(Number(order.segmentDistanceKm)) || Number.isFinite(Number(order.segmentDurationMin)) || Number.isFinite(Number(order.cumulativeDistanceKm)) || Number.isFinite(Number(order.etaMinutes))
          ? `<div class="route-stop-metrics">
                  ${Number.isFinite(Number(order.segmentDistanceKm)) ? `<span>Tramo: ${Number(order.segmentDistanceKm).toFixed(1)} km</span>` : ''}
                  ${Number.isFinite(Number(order.segmentDurationMin)) ? `<span>ETA tramo: ${Math.round(Number(order.segmentDurationMin))} min</span>` : ''}
                  ${Number.isFinite(Number(order.cumulativeDistanceKm)) ? `<span>Acumulado: ${Number(order.cumulativeDistanceKm).toFixed(1)} km</span>` : ''}
                  ${Number.isFinite(Number(order.etaMinutes)) ? `<span>Llega en: ${Math.round(Number(order.etaMinutes))} min</span>` : ''}
                </div>`
          : ''}
          </div>
          <span class="route-stop-tag">${escapeHtml(order.barrio || 'Sin barrio')}</span>
        </article>
      `).join('')
      : '<div class="product-group-empty">No hay pedidos listos para enrutar.</div>';
  }

  if (!mapContainer) return;

  // Si Google Maps está cargado, delegar el render a Google
  if (window.google && window.google.maps) {
    try {
      renderRoutesGoogle(routeSuggestion);
    } catch (err) {
      console.error('Error rendering with Google Maps:', err);
    }
    return;
  }

  if (typeof window.L === 'undefined') return;

  if (!routeMapInstance) {
    routeMapInstance = window.L.map('routeMap', { zoomControl: true }).setView([3.4516, -76.5320], 12);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19
    }).addTo(routeMapInstance);
    routeLayerGroup = window.L.layerGroup().addTo(routeMapInstance);
  }

  routeLayerGroup.clearLayers();

  if (!sequence.length) {
    window.L.marker([3.4516, -76.5320]).addTo(routeLayerGroup).bindPopup('Shadday Wok · Cali');
    routeMapInstance.setView([3.4516, -76.5320], 12);
    return;
  }

  const routePoints = sequence.map((order, index) => ({
    order,
    coordinates: getRouteCoordinate(order, index)
  }));

  const polylinePoints = routePoints.map((point) => point.coordinates);
  // Filtrar puntos inválidos
  const validRoutePoints = routePoints.filter(p => Array.isArray(p.coordinates) && p.coordinates.length === 2 && Number.isFinite(p.coordinates[0]) && Number.isFinite(p.coordinates[1]));

  validRoutePoints.forEach((point, index) => {
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
  });

  if (validRoutePoints.length) {
    const polylinePointsValid = validRoutePoints.map(p => p.coordinates);
    // Si la sugerencia incluye una geometría (GeoJSON) preferirla
    if (routeSuggestion && routeSuggestion.geometry && routeSuggestion.geometry.coordinates) {
      try {
        const geo = window.L.geoJSON(routeSuggestion.geometry, { style: { color: '#f59e0b', weight: 4, opacity: 0.8 } }).addTo(routeLayerGroup);
        routeMapInstance.fitBounds(geo.getBounds(), { padding: [30, 30] });
      } catch (e) {
        window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);
        if (polylinePointsValid.length === 1) routeMapInstance.setView(polylinePointsValid[0], 14);
        else routeMapInstance.fitBounds(polylinePointsValid, { padding: [30, 30] });
      }
    } else {
      window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);

      if (polylinePointsValid.length === 1) {
        routeMapInstance.setView(polylinePointsValid[0], 14);
      } else {
        routeMapInstance.fitBounds(polylinePointsValid, { padding: [30, 30] });
      }
    }
  } else {
    // No hay puntos válidos, centrar en la ciudad
    routeMapInstance.setView([3.4516, -76.5320], 12);
  }
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
      center: { lat: 3.4516, lng: -76.5320 },
      zoom: 12,
      mapId: 'DEMO_MAP_ID'
    });
  }

  // limpiar previos
  googleMarkers.forEach(m => m.setMap(null));
  googleMarkers = [];
  if (googlePolyline) { googlePolyline.setMap(null); googlePolyline = null; }

  const sequence = Array.isArray(routeSuggestion?.sequence) ? routeSuggestion.sequence : [];
  const points = sequence.map((order, idx) => ({ order, coord: getRouteCoordinate(order, idx) }))
    .filter(p => Array.isArray(p.coord) && p.coord.length === 2 && Number.isFinite(p.coord[0]));

  if (!points.length) {
    googleMapInstance.setCenter({ lat: 3.4516, lng: -76.5320 });
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

  points.forEach((p, i) => {
    const position = { lat: p.coord[0], lng: p.coord[1] };
    const info = new window.google.maps.InfoWindow({ content: `<strong>${escapeHtml(p.order.client_name || `Pedido #${p.order.id}`)}</strong><br/>${escapeHtml(p.order.barrio || '')}` });

    // Preferir AdvancedMarkerElement si está disponible (recomendado por Google)
    if (window.google.maps.marker && window.google.maps.marker.AdvancedMarkerElement) {
      const contentEl = document.createElement('div');
      contentEl.className = 'advanced-marker';
      contentEl.textContent = `${i + 1}`;
      const adv = new window.google.maps.marker.AdvancedMarkerElement({ position, map: googleMapInstance, title: p.order.client_name || `Pedido #${p.order.id}`, content: contentEl });
      adv.addEventListener('gmp-click', () => info.open({ anchor: adv }));
      googleMarkers.push(adv);
    } else {
      const marker = new window.google.maps.Marker({ position, map: googleMapInstance, label: `${i + 1}` });
      marker.addListener('click', () => info.open(googleMapInstance, marker));
      googleMarkers.push(marker);
    }
  });

  googlePolyline = new window.google.maps.Polyline({ path, strokeColor: '#f59e0b', strokeWeight: 4, map: googleMapInstance });

  if (path.length === 1) {
    googleMapInstance.setCenter(path[0]);
    googleMapInstance.setZoom(14);
  } else {
    const bounds = new window.google.maps.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    googleMapInstance.fitBounds(bounds);
  }
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
}

document.addEventListener('DOMContentLoaded', () => {
  wireSidebarNavigation();

  // Intentar cargar datos reales; en caso de error, usar muestra para la maqueta
  refreshDashboard().catch((err) => {
    console.warn('No se pudo cargar datos del backend, usando ejemplo local.', err);
    populateSampleOverview();
  }).finally(() => {
    // Attach handlers that require DOM + data
    attachDetailUpdateHandler();
    attachOrderDetailActions();
    // Setup modal opener for creating orders
    setupOrderModalOpener();
  });
  // Material Icons font is loaded; no runtime replace needed
});

// Handle updating order status from the detail panel
async function updateOrderStatusRequest(orderId, newStatus) {
  try {
    // Try backend first
    await request(`/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus })
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
        <div style="display:grid; gap:8px;">
          <button type="button" data-new-status="nuevo" class="btn-secondary">Nuevo</button>
          <button type="button" data-new-status="en preparación" class="btn-secondary">En preparación</button>
          <button type="button" data-new-status="listo para salir" class="btn-secondary">Listo para salir</button>
          <button type="button" data-new-status="en ruta" class="btn-secondary">En ruta</button>
          <button type="button" data-new-status="entregado" class="btn-secondary">Entregado</button>
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
          closeModals();
          updateOrderStatusRequest(orderId, newStatus);
        });
      });
    });
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
    form.clientId.value = client.id;
    form.name.value = client.name;
    form.phone.value = client.phone;
    form.notes.value = client.notes || '';
    if (client.primaryAddress) {
      form.address.value = client.primaryAddress.address;
      form.barrio.value = client.primaryAddress.barrio;
      form.reference.value = client.primaryAddress.reference;
      if (form.latitude) form.latitude.value = client.primaryAddress.latitude || '';
      if (form.longitude) form.longitude.value = client.primaryAddress.longitude || '';
    }
  } else {
    modalBody.querySelector('.tabs').style.display = 'none';
  }
  attachGeocoding(modalBody);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;

    // Validación de coordenadas para Clientes
    const lat = form.querySelector('[name="latitude"]')?.value;
    const lon = form.querySelector('[name="longitude"]')?.value;
    if (!lat || !lon) {
      showToast('Por favor selecciona una dirección de las sugerencias de Google.', 'error');
      return;
    }

    const data = getFormData(form);
    try {
      await request('/api/clients/resolve', {
        method: 'POST',
        body: JSON.stringify(data)
      });
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

async function fillOrderClientData(client) {
  const form = document.querySelector('#orderForm');
  if (!form) return;
  form.querySelector('[name="name"]').value = client.name;
  if (client.primaryAddress) {
    form.querySelector('[name="address"]').value = client.primaryAddress.address;
    form.querySelector('[name="barrio"]').value = client.primaryAddress.barrio;
    form.querySelector('[name="reference"]').value = client.primaryAddress.reference;
    const latInp = form.querySelector('[name="latitude"]');
    const lonInp = form.querySelector('[name="longitude"]');
    if (latInp) latInp.value = client.primaryAddress.latitude || '';
    if (lonInp) lonInp.value = client.primaryAddress.longitude || '';
  }
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

    if (editingOrder) {
      form.name.value = editingOrder.client_name;
      form.phone.value = editingOrder.client_phone;
      form.address.value = editingOrder.address;
      form.barrio.value = editingOrder.barrio;
      form.reference.value = editingOrder.reference || '';
      form.paymentMethod.value = editingOrder.payment_method;
      form.driverId.value = editingOrder.driver_id || '';
      form.notes.value = editingOrder.notes || '';
      if (editingOrder.latitude) form.latitude.value = editingOrder.latitude;
      if (editingOrder.longitude) form.longitude.value = editingOrder.longitude;
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
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Validación de coordenadas para Pedidos
      const lat = form.querySelector('[name="latitude"]')?.value;
      const lon = form.querySelector('[name="longitude"]')?.value;
      if (!lat || !lon) {
        showToast('No se puede guardar: La ubicación de Google Maps es obligatoria para el cálculo de rutas.', 'error');
        return;
      }

      form.classList.add('was-validated');
      if (!form.checkValidity() || !pendingItems.length) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        if (!pendingItems.length) showToast('Agrega al menos un producto a la comanda.', 'error');
        else showToast('Faltan datos obligatorios.', 'error');
        return;
      }
      const data = getFormData(e.target);
      try {
        const url = editingOrder ? `/api/orders/${editingOrder.id}` : '/api/orders';
        const method = editingOrder ? 'PATCH' : 'POST';
        const result = await request(url, {
          method,
          body: JSON.stringify({ client: { ...data }, paymentMethod: data.paymentMethod, driverId: data.driverId || null, items: pendingItems, notes: data.notes })
        });
        showToast(editingOrder ? 'Comanda actualizada' : `Comanda creada`, 'success');
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
  const total = pendingItems.reduce((s, i) => s + (i.quantity * i.unitPrice), 0);
  container.innerHTML = pendingItems.map((item, idx) => `
  <div class="row">
    <div style="flex:1;">${escapeHtml(item.name)}</div>
    <div class="qty-controls">
      <button type="button" onclick="pendingItems[${idx}].quantity = Math.max(1, pendingItems[${idx}].quantity - 1); renderPendingItemsInModal();">-</button>
      <span>${item.quantity}</span>
      <button type="button" onclick="pendingItems[${idx}].quantity = pendingItems[${idx}].quantity + 1; renderPendingItemsInModal();">+</button>
    </div>
    <strong>${money(item.quantity * item.unitPrice)}</strong>
    <button type="button" onclick="pendingItems.splice(${idx},1); renderPendingItemsInModal();">🗑️</button>
  </div>
`).join('') + `<div class="row">Total: ${money(total)}</div>`;
  const subtotalNode = document.getElementById('detailSubtotal'); if (subtotalNode) subtotalNode.textContent = money(total);
  const shippingNode = document.getElementById('detailShipping'); if (shippingNode) shippingNode.textContent = money(total > 0 ? 3000 : 0);
  const totalNode = document.getElementById('detailTotal'); if (totalNode) totalNode.textContent = money(total + (total > 0 ? 3000 : 0));
}

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

    // Handler para asignar la ruta sugerida al domiciliario seleccionado
    const assignBtn = document.getElementById('assignRouteBtn');
    if (assignBtn) {
      assignBtn.addEventListener('click', async () => {
        const driverSelect = document.getElementById('routeDriverSelect');
        const driverId = driverSelect ? Number(driverSelect.value) : null;

        const suggestedRoutes = dashboardState.routeSuggestion?.suggestedRoutes || [];
        const currentRoute = suggestedRoutes[dashboardState.selectedSuggestedRouteIndex];
        const sequence = currentRoute ? currentRoute.orders : [];

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
            const depot = { latitude: 3.4516, longitude: -76.5320 };
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
            body: JSON.stringify({ driverId, orderIds, route: finalSequence, routeSummary })
          });
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
        const suggestedRoutes = dashboardState.routeSuggestion?.suggestedRoutes || [];
        const currentRoute = suggestedRoutes[dashboardState.selectedSuggestedRouteIndex];
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

          if (!points.length) {
            showToast('No se pudieron obtener coordenadas válidas para los pedidos.', 'error');
            return;
          }

          const depot = { latitude: 3.4516, longitude: -76.5320 };
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

          const previewSuggestion = JSON.parse(JSON.stringify(dashboardState.routeSuggestion));
          previewSuggestion.suggestedRoutes[dashboardState.selectedSuggestedRouteIndex].orders = optimizedOrders;

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
      const cutoffHour = formData.cutoffHour || 20; // Get cutoffHour from form, default to 20
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

    // Auto-refresco de la actividad y estadísticas cada 30 segundos
    setInterval(async () => {
      await refreshDashboard();
    }, 30000);

  }

  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => {
      const status = document.getElementById('serverStatus');
      const msg = document.getElementById('orderMessage');
      if (status) status.textContent = 'Error al iniciar';
      if (msg) msg.textContent = error.message;
    });
  });
