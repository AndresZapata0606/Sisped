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
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || 'La solicitud fallo.');
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

function showModal({ title, body, confirmText = 'Aceptar', cancelText = 'Cancelar', onConfirm, onCancel }) {
  const overlay = document.getElementById('modalOverlay');
  const titleEl = document.getElementById('modalTitle');
  const bodyEl = document.getElementById('modalBody');
  const footerEl = document.getElementById('modalFooter');

  titleEl.textContent = title;
  bodyEl.innerHTML = body;
  footerEl.innerHTML = '';

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

  const btnConfirm = document.createElement('button');
  btnConfirm.className = 'primary';
  btnConfirm.textContent = confirmText;
  btnConfirm.onclick = () => {
    overlay.classList.remove('active');
    if (onConfirm) onConfirm();
  };
  footerEl.appendChild(btnConfirm);

  overlay.classList.add('active');
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

function renderClientResults(clients) {
  const container = document.getElementById('clientResults');

  if (!clients.length) {
    container.innerHTML = '<div class="subtle">Sin coincidencias.</div>';
    return;
  }

  container.innerHTML = clients.map((client) => `
    <article class="card">
      <h4>${client.name}</h4>
      <div class="meta">${client.phone} · ${client.address_count || 0} dirección(es)</div>
      <div class="subtle">${client.primaryAddress ? `${client.primaryAddress.address} · ${client.primaryAddress.barrio}` : 'Sin dirección principal guardada'}</div>
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

  container.innerHTML = products.map((product) => `
    <div class="row">
      <strong>${product.name}</strong>
      <div class="meta">${product.category} · ${money(product.price)} · ${product.active ? 'Activo' : 'Inactivo'}</div>
    </div>
  `).join('');

  select.innerHTML = products
    .filter((product) => Number(product.active) === 1)
    .map((product) => `<option value="${product.id}">${product.name} - ${money(product.price)}</option>`)
    .join('');
}

function renderDrivers(drivers) {
  const container = document.getElementById('driversList');

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

function renderPendingItems() {
  const container = document.getElementById('pendingItems');

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
  renderOrders(orders);
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

  // Auto-completado de cliente por teléfono en la Comanda
  const orderPhoneInput = document.querySelector('#orderForm [name="phone"]');
  orderPhoneInput.addEventListener('blur', async () => {
    const phone = orderPhoneInput.value.trim();
    const nameInput = document.querySelector('#orderForm [name="name"]');
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
  });

  function fillOrderClientData(client) {
    const form = document.getElementById('orderForm');
    form.querySelector('[name="name"]').value = client.name;
    if (client.primaryAddress) {
      form.querySelector('[name="address"]').value = client.primaryAddress.address;
      form.querySelector('[name="barrio"]').value = client.primaryAddress.barrio;
      form.querySelector('[name="reference"]').value = client.primaryAddress.reference;
    }
    showToast(`Datos de ${client.name} cargados`, 'info');
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

  document.getElementById('addItemButton').addEventListener('click', () => {
    const select = document.getElementById('orderProductSelect');
    const quantityInput = document.getElementById('orderQuantityInput');
    const productId = Number(select.value);
    const quantity = Math.max(1, Number(quantityInput.value) || 1);
    const option = select.selectedOptions[0];
    if (!option) {
      return;
    }

    const text = option.textContent.split(' - ');
    const name = text[0];
    const unitPrice = Number(String(text[1] || '0').replace(/[^0-9]/g, '')) || 0;

    // Buscar info adicional del producto (como si es combo)
    const productInfo = dashboardState.products.find(p => p.id === productId);
    const comboItems = productInfo?.combo_items ? JSON.parse(productInfo.combo_items) : [];

    pendingItems.push({ 
      productId, 
      quantity, 
      name, 
      unitPrice,
      isCombo: comboItems.length > 0,
      comboInfo: comboItems.join(', ')
    });

    quantityInput.value = 1;
    renderPendingItems();
  });

  document.getElementById('clearOrderForm').addEventListener('click', () => {
    document.getElementById('orderForm').reset();
    pendingItems.length = 0;
    renderPendingItems();
    syncOrderMessage('Formulario de comanda reiniciado.');
  });

  document.getElementById('pendingItems').addEventListener('click', (event) => {
    const removeIndex = event.target.dataset.itemRemove;
    if (removeIndex === undefined) {
      return;
    }
    pendingItems.splice(Number(removeIndex), 1);
    renderPendingItems();
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

  document.getElementById('orderForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      if (!pendingItems.length) {
        throw new Error('Agrega al menos un producto.');
      }

      const formData = getFormData(event.currentTarget);
      const result = await request('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          client: {
            name: formData.name,
            phone: formData.phone,
            address: formData.address,
            barrio: formData.barrio,
            reference: formData.reference,
            notes: formData.notes
          },
          paymentMethod: formData.paymentMethod,
          items: pendingItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          status: 'nuevo'
        })
      });

      pendingItems.length = 0;
      event.currentTarget.reset();
      syncOrderMessage(`Comanda #${result.order.id} creada con éxito.`);
      await refreshDashboard();
    } catch (error) {
      syncOrderMessage(error.message, true);
    }
  });

  document.getElementById('statsForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = getFormData(event.currentTarget);
    const cutoffHour = formData.cutoffHour || 20; // Get cutoffHour from form, default to 20
    const stats = await request(`/api/stats?range=${encodeURIComponent(formData.range)}&cutoffHour=${encodeURIComponent(cutoffHour)}`);
    renderStats(stats);
  });

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
  await loadClients('');
  await refreshDashboard();
}

main().catch((error) => {
  document.getElementById('serverStatus').textContent = 'Error al iniciar';
  document.getElementById('orderMessage').textContent = error.message;
});
