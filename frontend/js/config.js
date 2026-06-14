/**
 * API base URL — same origin on Railway; localhost:5000 when using `npm run serve` on port 3000.
 */
(function () {
    var origin = window.location.origin;
    if (origin.includes('localhost') && window.location.port === '3000') {
        window.QALAM_API_BASE = 'http://localhost:5000';
    } else {
        window.QALAM_API_BASE = origin;
    }
})();
