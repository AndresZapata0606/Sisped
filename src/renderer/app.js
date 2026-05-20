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
  routeSuggestion: null,
  stats: null
};

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

function money(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(Number(value || 0));
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
      let label = 'Guardar';
      if (nativeSubmit) {
        label = (nativeSubmit.textContent || nativeSubmit.value || label).trim();
        nativeSubmit.style.display = 'none';
      }

      const footerSubmit = document.createElement('button');
      footerSubmit.className = 'primary';
      footerSubmit.textContent = label;
      footerSubmit.onclick = () => {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      };

      footerEl.appendChild(footerSubmit);
    }
  }

  overlay.classList.add('active');
}

function closeModals() {
  document.getElementById('modalOverlay').classList.remove('active');
  // Limpiar campos si es necesario
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

async function loadClients(query = '') {
  const clients = await request(`/api/clients?q=${encodeURIComponent(query)}`);
  renderClientResults(clients);
}

function renderProducts(products) {
  const container = document.getElementById('productsList');
  const select = document.getElementById('orderProductSelect');

  const getProductCard = (product) => {
    const comboItems = parseComboItems(product.combo_items);
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
          <div class="product-detail-label">Catálogo listo para comandera</div>
          <p>${isCombo ? `Incluye ${comboItems.length} ítem(s).` : 'Producto individual para la comandera diaria.'}</p>
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

  const comboProducts = products.filter((product) => parseComboItems(product.combo_items).length > 0 || String(product.category || '').toLowerCase().includes('combo'));
  const individualProducts = products.filter((product) => !parseComboItems(product.combo_items).length && !String(product.category || '').toLowerCase().includes('combo'));
  const sections = {
    all: [
      getGroupMarkup('Productos individuales', individualProducts, 'No hay productos individuales registrados.'),
      getGroupMarkup('Combos', comboProducts, 'No hay combos registrados.')
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
            <div class="driver-card-meta">${escapeHtml(driver.vehicle)} · ${escapeHtml(driver.zone || 'Sin zona')} · ${escapeHtml(driver.current_status || 'disponible')}</div>
          </div>
          <div class="driver-card-badge">${driver.active ? 'Disponible' : 'Fuera de turno'}</div>
        </div>

        <div class="driver-card-body">
          <div class="driver-detail-label">Contacto</div>
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

  // Render as a timeline with icons and priority tags
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
}

function renderOrdersChart() {
  const container = document.getElementById('ordersChart');
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

  document.getElementById('topClientName').textContent = topClient ? topClient.name : 'Sin datos';
  document.getElementById('topClientMeta').textContent = topClient
    ? `${topClient.phone} · ${topClient.count} pedidos · ${money(topClient.total)}`
    : 'Todavía no hay suficiente historial para calcularlo.';
  document.getElementById('topClientOrders').textContent = topClient ? `${topClient.count} pedidos` : '0 pedidos';
  document.getElementById('topClientTotal').textContent = topClient ? `${money(topClient.total)} total` : '$0 total';

  document.getElementById('topDriverName').textContent = topDriver ? topDriver.name : 'Sin datos';
  document.getElementById('topDriverMeta').textContent = topDriver
    ? `${topDriver.zone} · ${topDriver.total} pedidos asignados`
    : 'Se actualiza con la operación diaria.';
  document.getElementById('topDriverOrders').textContent = topDriver ? `${topDriver.total} pedidos` : '0 pedidos';
  document.getElementById('topDriverZone').textContent = topDriver ? topDriver.zone : 'Sin zona';

  document.getElementById('topProductName').textContent = stats ? stats.topProduct : 'Sin datos';
  document.getElementById('topProductMeta').textContent = stats && stats.topProduct !== 'Sin datos' ? `El producto más vendido en el rango.` : 'Todavía no hay suficiente historial.';
  document.getElementById('topProductCount').textContent = stats && stats.topProduct !== 'Sin datos' ? `${stats.topProductCount || 0} unidades` : '0 unidades'; // Assuming topProductCount is available in stats

  document.getElementById('topStatusName').textContent = topStatus[0];
  document.getElementById('topStatusMeta').textContent = `${topStatus[1]} pedidos dentro del estado dominante.`;
  document.getElementById('topStatusCount').textContent = `${topStatus[1]} pedidos`;
  document.getElementById('topStatusHint').textContent = topStatus[1] > 0 ? 'Lectura rápida del día' : 'Sin actividad dominante';
}

async function refreshDashboard() {
  const cutoffHour = document.querySelector('#statsForm [name="cutoffHour"]')?.value || 20;
  const routeDriverId = document.getElementById('routeDriverSelect')?.value || '';
  
  const [products, drivers, orders, stats] = await Promise.all([
    request('/api/products'),
    request('/api/drivers'),
    request('/api/orders'),
    request(`/api/stats?range=day&cutoffHour=${cutoffHour}`)
  ]);

  const routeSuggestion = await request(`/api/routes/suggest?driverId=${encodeURIComponent(routeDriverId)}`);

  dashboardState.products = products;
  dashboardState.drivers = drivers;
  dashboardState.orders = orders;
  dashboardState.stats = stats;
  dashboardState.routeSuggestion = routeSuggestion;

  renderProducts(products);
  renderDrivers(drivers);
  
  // Aplicar filtro de búsqueda si existe un término activo
  const searchInput = document.getElementById('orderSearchInput');
  const term = searchInput ? searchInput.value.trim() : '';
  if (term) {
    const filtered = orders.filter(o => String(o.id).includes(term));
    renderOrders(filtered);
  } else {
    renderOrders(orders);
  }

  renderPendingItems();
  renderStats(stats);
  renderOverviewKpis();
  renderOverviewInsights();
  renderOrdersChart();
  renderRoutes(routeSuggestion, drivers);
  document.getElementById('serverStatus').textContent = 'Servidor local activo';
}

function renderRoutes(routeSuggestion, drivers) {
  const driverSelect = document.getElementById('routeDriverSelect');
  const mapContainer = document.getElementById('routeMap');
  const sequenceContainer = document.getElementById('routeSequence');
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

  const sequence = Array.isArray(routeSuggestion?.sequence) ? routeSuggestion.sequence : [];
  const grouped = routeSuggestion?.grouped || {};
  const groupedEntries = Object.entries(grouped);

  if (orderCount) {
    orderCount.textContent = String(sequence.length);
  }

  if (neighborhoodCount) {
    neighborhoodCount.textContent = String(groupedEntries.length);
  }

  if (distanceNode) {
    const estimatedDistance = Math.max(sequence.length * 1.8, groupedEntries.length * 2.4, sequence.length ? 2 : 0);
    distanceNode.textContent = `${estimatedDistance.toFixed(1)} km`;
  }

  if (etaNode) {
    const estimatedMinutes = Math.max(sequence.length * 8 + groupedEntries.length * 6, 0);
    etaNode.textContent = `${estimatedMinutes} min`;
  }

  if (sequenceContainer) {
    sequenceContainer.innerHTML = sequence.length
      ? sequence.map((order, index) => `
        <article class="route-stop">
          <div class="route-stop-index">${index + 1}</div>
          <div class="route-stop-body">
            <strong>${escapeHtml(order.client_name || `Pedido #${order.id}`)}</strong>
            <p>${escapeHtml(order.barrio || 'Sin barrio')} · ${escapeHtml(order.address || 'Sin dirección')}</p>
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
    // Si la sugerencia incluye una geometría (GeoJSON) preferirla
    if (routeSuggestion && routeSuggestion.geometry && routeSuggestion.geometry.coordinates) {
      try {
        const geo = window.L.geoJSON(routeSuggestion.geometry, { style: { color: '#f59e0b', weight: 4, opacity: 0.8 } }).addTo(routeLayerGroup);
        routeMapInstance.fitBounds(geo.getBounds(), { padding: [30, 30] });
      } catch (e) {
        const polylinePointsValid = validRoutePoints.map(p => p.coordinates);
        window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);
        if (polylinePointsValid.length === 1) routeMapInstance.setView(polylinePointsValid[0], 14);
        else routeMapInstance.fitBounds(polylinePointsValid, { padding: [30, 30] });
      }
    } else {
      const polylinePointsValid = validRoutePoints.map(p => p.coordinates);
      window.L.polyline(polylinePointsValid, { color: '#f59e0b', weight: 4, opacity: 0.8 }).addTo(routeLayerGroup);

      if (polylinePointsValid.length === 1) {
        routeMapInstance.setView(polylinePointsValid[0], 14);
      } else {
        routeMapInstance.fitBounds(polylinePointsValid, { padding: [30, 30] });
      }
    }

    if (polylinePointsValid.length === 1) {
      routeMapInstance.setView(polylinePointsValid[0], 14);
    } else {
      routeMapInstance.fitBounds(polylinePointsValid, { padding: [30, 30] });
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
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
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
      zoom: 12
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
      adv.addListener('click', () => info.open({ anchor: adv }));
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

function syncOrderMessage(message, isError = false) {
  const element = document.getElementById('orderMessage');
  element.textContent = message;
  element.style.color = isError ? '#fecaca' : '#bfdbfe';
}

async function main() {
  wireSidebarNavigation();

  // --- Gestión de Clientes ---

  document.getElementById('openClientModal').addEventListener('click', () => {
    openClientModal();
  });

  document.getElementById('clientResults').addEventListener('click', async (e) => {
    const clientId = e.target.dataset.clientEdit;
    if (!clientId) return;

    // Buscar datos completos del cliente en el estado actual
    const clients = await request(`/api/clients?q=${clientId}`); // Búsqueda por ID o similar
    const client = clients.find(c => String(c.id) === clientId);
    
    if (client) openClientModal(client);
  });

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
      }
    } else {
      modalBody.querySelector('.tabs').style.display = 'none';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.classList.add('was-validated');
      if (!form.checkValidity()) return;

      const data = getFormData(form);
      try {
        await request('/api/clients/resolve', {
          method: 'POST',
          body: JSON.stringify(data)
        });
        showToast(client ? 'Cliente actualizado' : 'Cliente registrado con éxito', 'success');
        closeModals();
        // Refrescar lista si estamos en la vista de clientes
        const searchVal = document.getElementById('clientSearchInput').value;
        await loadClients(searchVal);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // --- Gestión de Comandas ---

  // Lógica para abrir comanda en modal
  document.getElementById('openOrderModal').addEventListener('click', () => {
    openOrderPanel();
  });

  // Auto-completado de cliente por teléfono en la Comanda
  async function handlePhoneBlur(event) {
    const phone = event.target.value.trim();
    const nameInput = document.querySelector('.modal-body [name="name"]');
    const currentNameInput = nameInput.value.trim();

    if (phone.length >= 7) {
      try {
        const clients = await request(`/api/clients?q=${encodeURIComponent(phone)}`);
        const normalizedPhone = phone.replace(/\D/g, '');
        const existing = clients.find(c => c.phone.replace(/\D/g, '') === normalizedPhone);

        if (existing) {
          // Regla: Confirmación manual si el nombre ingresado difiere del registrado
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
    
    // Carga de direcciones múltiples
    try {
      const addresses = await request(`/api/clients/${client.id}/addresses`);
      const addrContainer = form.querySelector('#addressSelectorContainer');
      const addrSelect = form.querySelector('#savedAddressSelect');
      
      if (addresses.length > 0) {
        addrSelect.innerHTML = '<option value="">-- Seleccionar dirección --</option>' + 
          addresses.map(a => `<option value="${a.id}">${a.label.toUpperCase()}: ${a.address} (${a.barrio})</option>`).join('');
        addrContainer.style.display = 'block';
        
        addrSelect.onchange = (e) => {
          const selected = addresses.find(a => String(a.id) === e.target.value);
          if (selected) {
            form.querySelector('[name="address"]').value = selected.address;
            form.querySelector('[name="barrio"]').value = selected.barrio;
            form.querySelector('[name="reference"]').value = selected.reference;
          }
        };
      }
    } catch (err) { console.error('Error cargando direcciones:', err); }

    if (client.primaryAddress) {
      form.querySelector('[name="address"]').value = client.primaryAddress.address;
      form.querySelector('[name="barrio"]').value = client.primaryAddress.barrio;
      form.querySelector('[name="reference"]').value = client.primaryAddress.reference;
    }
    showToast(`Cliente ${client.name} vinculado`, 'info');
  }

  function attachOrderFormEvents(container = document) {
    const form = container.querySelector('#orderForm');
    if (!form) return;
    
    // Llenar selectores
    const productSelect = form.querySelector('#orderProductSelect');
    const productSearch = form.querySelector('#orderProductSearch');

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

    // Eventos de productos
    form.querySelector('#addItemButton').addEventListener('click', () => {
      const productId = Number(productSelect.value);
      const qtyInput = form.querySelector('#orderQuantityInput');
      const qty = Number(qtyInput.value) || 1;
      
      const product = dashboardState.products.find(p => p.id === productId);
      pendingItems.push({ 
        productId, 
        quantity: qty, 
        name: product.name, 
        unitPrice: product.price 
      });
      qtyInput.value = 1;
      renderPendingItemsInModal();
    });

    form.querySelector('[name="phone"]').addEventListener('blur', handlePhoneBlur);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      // Activamos los estilos de validación visual
      form.classList.add('was-validated');

      // Validamos integridad del formulario y lista de productos
      if (!form.checkValidity() || !pendingItems.length) {
        form.classList.add('shake-form');
        setTimeout(() => form.classList.remove('shake-form'), 500);
        
        if (!pendingItems.length) {
          showToast('Agrega al menos un producto a la comanda.', 'error');
        } else {
          showToast('Faltan datos obligatorios. Revisa los campos en rojo.', 'error');
          form.querySelector('[required]:invalid')?.focus();
        }
        return;
      }

      const data = getFormData(e.target);
      try {
        const result = await request('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            client: { ...data },
            paymentMethod: data.paymentMethod,
            driverId: data.driverId || null,
            items: pendingItems,
            notes: data.notes
          })
        });
        showToast(`Comanda #${result.order.id} creada`, 'success');
        pendingItems.length = 0;
        closeOrderPanel();
        await refreshDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  function renderPendingItemsInModal() {
    const container = document.querySelector('#pendingItems');
    const total = pendingItems.reduce((s, i) => s + (i.quantity * i.unitPrice), 0);
    
    container.innerHTML = pendingItems.map((item, idx) => `
      <div class="row">
        <span>${item.name} x${item.quantity}</span>
        <strong>${money(item.quantity * item.unitPrice)}</strong>
        <button type="button" onclick="pendingItems.splice(${idx},1); renderPendingItemsInModal();">x</button>
      </div>
    `).join('') + `<div class="row">Total: ${money(total)}</div>`;
  }

  document.getElementById('clientSearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = document.getElementById('clientSearchInput').value.trim();
    await loadClients(query);
  });

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
      const sequence = Array.isArray(dashboardState.routeSuggestion?.sequence) ? dashboardState.routeSuggestion.sequence : [];

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
          body: JSON.stringify({ driverId, orderIds, route: finalSequence })
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
      const sequence = Array.isArray(dashboardState.routeSuggestion?.sequence) ? dashboardState.routeSuggestion.sequence : [];
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

        const previewSuggestion = Object.assign({}, dashboardState.routeSuggestion || {}, { sequence: optimizedOrders });
        if (opt.geometry) previewSuggestion.geometry = opt.geometry;

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

  document.getElementById('driversList').addEventListener('click', async (event) => {
    const driverId = event.target.dataset.driverToggle;
    const editId = event.target.dataset.driverEdit;
    const deleteId = event.target.dataset.driverDelete;

    if (driverId) {
      const isActivating = event.target.dataset.active === '1';
      showToast(`Domiciliario ${isActivating ? 'activado' : 'desactivado'}`, 'info');

      await request(`/api/drivers/${driverId}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ active: event.target.dataset.active === '1' })
      });
      await refreshDashboard();
      return;
    }

    if (editId) {
      const driver = dashboardState.drivers.find((item) => item.id === Number(editId));
      if (driver) {
        openDriverModal(driver);
      }
      return;
    }

    if (deleteId) {
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
  document.getElementById('productsList').addEventListener('click', async (event) => {
    const productId = event.target.dataset.productToggle;
    const editId = event.target.dataset.productEdit;
    const deleteId = event.target.dataset.productDelete;

    if (productId) {
      const isActivating = event.target.dataset.active === '1';
      showToast(`Producto ${isActivating ? 'activado' : 'desactivado'}`, 'info');
      await request(`/api/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: event.target.dataset.active === '1' })
      });
      await refreshDashboard();
    } else if (editId) {
      const product = dashboardState.products.find(p => p.id === Number(editId));
      if (product) {
        openProductModal(product);
      }
    } else if (deleteId) {
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

  // Order panel controls
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

  // Buscador de pedidos por ID en tiempo real
  document.getElementById('orderSearchInput').addEventListener('input', (e) => {
    const term = e.target.value.trim();
    if (!term) {
      renderOrders(dashboardState.orders);
      return;
    }
    const filtered = dashboardState.orders.filter(o => String(o.id).includes(term));
    renderOrders(filtered);
  });

  // Auto-refresco de la actividad y estadísticas cada 30 segundos
  setInterval(async () => {
    await refreshDashboard();
  }, 30000);

  await loadClients('');
  await refreshDashboard();
}

main().catch((error) => {
  const status = document.getElementById('serverStatus');
  const msg = document.getElementById('orderMessage');
  if (status) status.textContent = 'Error al iniciar';
  if (msg) msg.textContent = error.message;
});
