// HUD 外壳行为（收起/展开）不依赖 Cesium 引擎加载，页面一就绪即可用
(function () {
  const hud = document.getElementById('hud');
  const toggle = document.getElementById('hudToggle');
  if (!hud || !toggle) return;
  const init = () => { if (innerWidth <= 640) hud.classList.add('collapsed'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  toggle.addEventListener('click', () => hud.classList.toggle('collapsed'));
})();
