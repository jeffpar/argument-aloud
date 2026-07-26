  (function () {
    var topUl = document.querySelector('.wrapper > ul');
    if (!topUl) return;
    Array.prototype.forEach.call(topUl.children, function (li) {
      var subUl = li.querySelector(':scope > ul');
      if (!subUl) return;
      var tog = document.createElement('span');
      tog.className = 'tu-toggle';
      tog.textContent = '▶︎';
      li.insertBefore(tog, li.firstChild);
      li.addEventListener('click', function (e) {
        if (e.target.closest('a')) return; // let case/turn links navigate normally
        li.classList.toggle('tu-open');
      });
    });
  })();
