// A short, friendly list of time zones for the places salons usually operate. The API accepts any valid IANA zone,
// so a branch already set to something else keeps it (see `withCurrent`).
export const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'Asia/Kolkata', label: 'India (Kolkata, UTC+5:30)' },
  { value: 'Asia/Dubai', label: 'UAE (Dubai, UTC+4)' },
  { value: 'Asia/Karachi', label: 'Pakistan (Karachi, UTC+5)' },
  { value: 'Asia/Dhaka', label: 'Bangladesh (Dhaka, UTC+6)' },
  { value: 'Asia/Colombo', label: 'Sri Lanka (Colombo, UTC+5:30)' },
  { value: 'Asia/Kathmandu', label: 'Nepal (Kathmandu, UTC+5:45)' },
  { value: 'Asia/Singapore', label: 'Singapore (UTC+8)' },
  { value: 'Asia/Kuala_Lumpur', label: 'Malaysia (Kuala Lumpur, UTC+8)' },
  { value: 'Asia/Bangkok', label: 'Thailand (Bangkok, UTC+7)' },
  { value: 'Asia/Manila', label: 'Philippines (Manila, UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Japan (Tokyo, UTC+9)' },
  { value: 'Asia/Riyadh', label: 'Saudi Arabia (Riyadh, UTC+3)' },
  { value: 'Africa/Nairobi', label: 'Kenya (Nairobi, UTC+3)' },
  { value: 'Africa/Lagos', label: 'Nigeria (Lagos, UTC+1)' },
  { value: 'Africa/Johannesburg', label: 'South Africa (UTC+2)' },
  { value: 'Europe/London', label: 'United Kingdom (London)' },
  { value: 'Europe/Paris', label: 'Central Europe (Paris)' },
  { value: 'America/New_York', label: 'US Eastern (New York)' },
  { value: 'America/Chicago', label: 'US Central (Chicago)' },
  { value: 'America/Denver', label: 'US Mountain (Denver)' },
  { value: 'America/Los_Angeles', label: 'US Pacific (Los Angeles)' },
  { value: 'America/Toronto', label: 'Canada Eastern (Toronto)' },
  { value: 'Australia/Sydney', label: 'Australia East (Sydney)' },
  { value: 'Pacific/Auckland', label: 'New Zealand (Auckland)' },
];

export function withCurrent(current: string | undefined | null): Array<{ value: string; label: string }> {
  if (!current || TIMEZONES.some((t) => t.value === current)) return TIMEZONES;
  return [{ value: current, label: current }, ...TIMEZONES];
}
