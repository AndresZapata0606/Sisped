const baseUrl = window.location.origin;
const pendingItems = [];
const dashboardState = {
  products: [],
  drivers: [],
  orders: [],
  stats: null
};

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

  if (container) {
    container.innerHTML = products.map((product) => `
      <div class="row">
        <strong>${product.name}</strong>
        <div class="meta">${product.category} · ${money(product.price)} · ${product.active ? 'Activo' : 'Inactivo'}</div>
      </div>
    `).join('');
  }

  if (select) {
    select.innerHTML = products
      .filter((product) => Number(product.active) === 1)
      .map((product) => `<option value="${product.id}">${product.name} - ${money(product.price)}</option>`)
      .join('');
  }
}

function renderDrivers(drivers) {
  const container = document.getElementById('driversList');
  const orderDriverSelect = document.getElementById('orderDriverSelect');

  const activeDrivers = drivers.filter((d) => Number(d.active) === 1);

  // Actualizar selector en la comanda
  if (orderDriverSelect) {
    orderDriverSelect.innerHTML = '<option value="">Sin asignar (despacho manual)</option>' + 
      activeDrivers.map(d => `<option value="${d.id}">${d.name} (${d.zone || 'Sin zona'})</option>`).join('');
  }

  if (container) {
    container.innerHTML = drivers.map((driver) => `
      <div class="row">
        <strong>${driver.name}</strong>
        <div class="meta">${driver.vehicle} · ${driver.zone || 'Sin zona'} · ${driver.current_status}</div>
        <div class="tag-row">
          <span class="tag ${driver.active ? 'success' : 'warning'}">${driver.active ? 'Activo' : 'Inactivo'}</span>
          <button type="button" data-driver-toggle="${driver.id}" data-active="${driver.active ? '0' : '1'}">
            ${driver.active ? 'Desactivar' : 'Activar'}
          </button>
        </div>
      </div>
    `).join('');
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
  if (s === 'nuevo') return '🟦';
  if (s === 'en preparación') return '🟨';
  if (s === 'listo para salir') return '✅';
  if (s === 'en ruta') return '🚚';
  if (s === 'entregado') return '📦';
  if (s === 'cancelado') return '🚫';
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
  const container = document.getElementById('statsCards');

  container.innerHTML = `
    <div class="stat"><strong>${stats.totalOrders}</strong><span>Pedidos totales</span></div>
    <div class="stat"><strong>${stats.deliveredOrders}</strong><span>Pedidos entregados</span></div>
    <div class="stat"><strong>${stats.cancelledOrders}</strong><span>Pedidos cancelados</span></div>
    <div class="stat"><strong>${money(stats.totalSales)}</strong><span>Ventas totales</span></div>
    <div class="stat"><strong>${(stats.averageDeliveryTimeMinutes || 0).toFixed(0)} min</strong><span>Tiempo promedio entrega</span></div>
    <div class="stat"><strong>${money(stats.averageTicket)}</strong><span>Ticket promedio</span></div>
    <div class="stat"><strong>${stats.topProduct}</strong><span>Producto mas vendido</span></div>
    <div class="stat"><strong>${stats.topDriver}</strong><span>Domiciliario lider</span></div>
    <div class="stat"><strong>${stats.range}</strong><span>Rango consultado</span></div>
  `;
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
  
  const [products, drivers, orders, stats] = await Promise.all([
    request('/api/products'),
    request('/api/drivers'),
    request('/api/orders'),
    request(`/api/stats?range=day&cutoffHour=${cutoffHour}`)
  ]);

  dashboardState.products = products;
  dashboardState.drivers = drivers;
  dashboardState.orders = orders;
  dashboardState.stats = stats;

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
  document.getElementById('serverStatus').textContent = 'Servidor local activo';
}

function getFormData(form) {
  return Object.fromEntries(new FormData(form).entries());
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

  document.getElementById('productForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = getFormData(event.currentTarget);
    await request('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: formData.name,
        category: formData.category,
        price: formData.price,
        active: true,
        comboItems: []
      })
    });
    event.currentTarget.reset();
    await refreshDashboard();
  });

  document.getElementById('driverForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = getFormData(event.currentTarget);
    await request('/api/drivers', {
      method: 'POST',
      body: JSON.stringify(formData)
    });
    event.currentTarget.reset();
    await refreshDashboard();
  });

  document.getElementById('driverForm').addEventListener('click', async (event) => {
    const driverId = event.target.dataset.driverToggle;
    if (driverId === undefined) {
      return;
    }
    
    const isActivating = event.target.dataset.active === '1';
    showToast(`Domiciliario ${isActivating ? 'activado' : 'desactivado'}`, 'info');

    await request(`/api/drivers/${driverId}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ active: event.target.dataset.active === '1' })
    });
    await refreshDashboard();
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
