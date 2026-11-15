/**
 * Haversine formula to calculate the great-circle distance between two points on a sphere (Earth).
 *
 * @param {number} lat1 Latitude of point 1 in degrees
 * @param {number} lon1 Longitude of point 1 in degrees
 * @param {number} lat2 Latitude of point 2 in degrees
 * @param {number} lon2 Longitude of point 2 in degrees
 * @returns {number} Distance in kilometers
 */
export const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  if (
    lat1 === undefined || lon1 === undefined ||
    lat2 === undefined || lon2 === undefined ||
    lat1 === null || lon1 === null ||
    lat2 === null || lon2 === null
  ) {
    return Infinity;
  }

  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  // Round to 2 decimal places
  return Math.round(distance * 100) / 100;
};

const toRad = (degrees) => {
  return (degrees * Math.PI) / 180;
};

/**
 * Estimate response arrival time (ETA) in minutes
 * @param {number} distanceKm Distance in kilometers
 * @param {number} avgSpeedKmh Average speed in km/h (default 40 km/h)
 * @returns {number} ETA in minutes (minimum 2 minutes)
 */
export const estimateEtaMinutes = (distanceKm, avgSpeedKmh = 40) => {
  if (!distanceKm || distanceKm === Infinity || distanceKm <= 0) return 2;
  const hours = distanceKm / avgSpeedKmh;
  const minutes = Math.ceil(hours * 60);
  return Math.max(2, minutes);
};

/**
 * Human-readable distance formatter
 */
export const formatDistance = (distanceKm) => {
  if (distanceKm === undefined || distanceKm === null || distanceKm === Infinity) {
    return 'Distance unknown';
  }
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)} m`;
  }
  return `${distanceKm.toFixed(1)} km`;
};
