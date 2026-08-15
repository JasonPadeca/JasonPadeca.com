/* =========================================================
   Deslop — confirmation page
   Every figure here comes from the server, which recounted the
   words and repriced the job from the stored text. Nothing on
   this page is computed from anything the browser held onto.

   The submitted text is written with textContent only. It is
   attacker-supplied by definition, and this page is also the
   one Ben opens to read a job.
   ========================================================= */

(function () {
  'use strict';

  var cfg = window.DESLOP_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };

  var stateEl = $('state');
  var orderEl = $('order');
  var payBtn  = $('pay');

  function money(cents) {
    var n = (cents || 0) / 100;
    return '$' + (n % 1 === 0 ? n.toLocaleString('en-US')
                              : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }

  function fail(msg) {
    stateEl.textContent = msg;
    stateEl.className = 'state state-error';
    orderEl.hidden = true;
  }

  function api(path, body) {
    if (!cfg.FUNCTIONS_URL || !cfg.SUPABASE_ANON_KEY) {
      return Promise.reject(new Error('This site is not finished being set up yet.'));
    }
    return fetch(cfg.FUNCTIONS_URL + '/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
      });
    });
  }

  /** One label/value line in the summary block. */
  function row(label, value, opts) {
    var wrap = document.createElement('div');
    wrap.className = 'summary-row' + (opts && opts.total ? ' summary-total' : '');
    var k = document.createElement('span');
    k.className = 'summary-key';
    k.textContent = label;
    var v = document.createElement('span');
    v.className = 'summary-val';
    v.textContent = value;
    wrap.appendChild(k);
    wrap.appendChild(v);
    return wrap;
  }

  function render(order) {
    var summary = $('summary');
    summary.textContent = '';

    summary.appendChild(row('Words received', order.wordCount.toLocaleString('en-US')));

    if (order.billableWords > order.wordCount) {
      summary.appendChild(row('Billed as', order.billableWords.toLocaleString('en-US') + ' words (50-word minimum)'));
    }

    summary.appendChild(row('Rate', order.rush ? '$1.00 per word, rush' : '50¢ per word'));
    summary.appendChild(row('Turnaround', order.rush
      ? 'Straight to the front of the queue'
      : 'Most work comes back the same day'));
    summary.appendChild(row('Sending to', order.email));

    // The submitted text: textContent into a <pre>, never innerHTML.
    $('sent').textContent = order.text || '(nothing stored)';

    var payBlock = $('pay-block');
    var note = $('pay-note');

    if (order.isSample) {
      summary.appendChild(row('Total', 'Free sample', { total: true }));
      payBlock.hidden = true;
      stateEl.textContent = 'Your sample request is in. A writer reads every one, so give us a day or two — we\'ll reply to ' + order.email + '.';
      stateEl.className = 'state state-ok';
    } else if (order.status !== 'pending') {
      summary.appendChild(row('Total', money(order.amountCents), { total: true }));
      payBlock.hidden = true;
      $('wrong').hidden = true;
      stateEl.textContent = order.status === 'paid'
        ? 'Paid. We have it, and we\'re on it.'
        : 'This order is marked "' + order.status + '".';
      stateEl.className = 'state state-ok';
    } else {
      summary.appendChild(row('Total', money(order.amountCents), { total: true }));
      payBtn.textContent = 'Pay ' + money(order.amountCents);
      note.hidden = false;
      stateEl.hidden = true;
    }

    orderEl.hidden = false;
  }

  var token = new URLSearchParams(window.location.search).get('order') || '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    fail('That order link doesn\'t look right. Try starting again.');
    return;
  }

  api('get-order', { token: token })
    .then(render)
    .catch(function (e) { fail(e.message); });

  payBtn.addEventListener('click', function () {
    payBtn.disabled = true;
    payBtn.textContent = 'Taking you to Stripe…';
    api('create-checkout', { token: token })
      .then(function (out) {
        if (!out.url) throw new Error('Stripe did not return a checkout page.');
        window.location.href = out.url;
      })
      .catch(function (e) {
        payBtn.disabled = false;
        payBtn.textContent = 'Try again';
        fail(e.message);
      });
  });
})();
