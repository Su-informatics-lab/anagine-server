/**
 * Data preparation utilities (from upstream).
 * Used by analysis routes to extract x/y arrays from fetched data.
 */
export function buildXYFromFetchedData(fetchedData, xField, yField) {
  const x = [];
  const y = [];

  for (let i = 0; i < fetchedData.length; i++) {
    const row = fetchedData[i];

    const xv = Number(row?.[xField]);
    const yv = yField ? Number(row?.[yField]) : i;

    if (Number.isFinite(xv) && Number.isFinite(yv)) {
      x.push(xv);
      y.push(yv);
    }
  }

  return { x, y };
}
