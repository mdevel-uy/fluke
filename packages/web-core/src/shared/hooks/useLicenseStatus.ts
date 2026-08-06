import { useQuery } from '@tanstack/react-query';

import { licenseApi, type LicenseStatusResponse } from '@/shared/lib/api';

const LICENSE_STATUS_QUERY_KEY = ['license-status'] as const;

/**
 * Licensing status for the banner. On builds with no embedded public key
 * (dev, current fleet) the backend reports `enforced: false` and `status:
 * "valid"`, so the banner never shows.
 *
 * The state changes on the scale of days (grace period, expiry), so a low
 * poll frequency is plenty; we also refetch on focus so an operator returning
 * to the tab sees the current state without a manual reload.
 */
export function useLicenseStatus() {
  return useQuery<LicenseStatusResponse>({
    queryKey: LICENSE_STATUS_QUERY_KEY,
    queryFn: () => licenseApi.get(),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: true,
  });
}
