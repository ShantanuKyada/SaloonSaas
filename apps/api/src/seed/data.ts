// Demo content for "Glow Salon Group". Pure data: names, prices (paise), durations.

export const FIRST_NAMES_F = ['Aarti', 'Anjali', 'Bhavna', 'Chandni', 'Darshana', 'Disha', 'Foram', 'Gauri', 'Hetal', 'Isha', 'Jinal', 'Kavita', 'Krupa', 'Lata', 'Mansi', 'Meera', 'Nidhi', 'Nirali', 'Pallavi', 'Payal', 'Rashmi', 'Riddhi', 'Sapna', 'Shruti', 'Tanvi', 'Urvi', 'Vaishali', 'Zalak', 'Hiral', 'Komal'];
export const FIRST_NAMES_M = ['Aman', 'Bhavin', 'Chirag', 'Dhruv', 'Harsh', 'Jay', 'Kunal', 'Mehul', 'Nikhil', 'Parth', 'Raj', 'Sagar', 'Tejas', 'Utsav', 'Vivek', 'Yash'];
export const SURNAMES = ['Patel', 'Shah', 'Mehta', 'Desai', 'Joshi', 'Trivedi', 'Pandya', 'Vyas', 'Parekh', 'Modi', 'Thakkar', 'Bhatt', 'Dave', 'Gandhi', 'Sheth', 'Rathod', 'Solanki', 'Chauhan', 'Jadeja', 'Raval'];

export const EXPERTISE = ['Hair Artist', 'Senior Hair Artist', 'Hair Stylist', 'Colorist', 'Barber', 'Masseuse', 'Makeup Artist', 'Nail Artist', 'Skin Specialist', 'Facial Specialist'];

export interface ServiceSeed {
  code: string;
  name: string;
  category: string;
  price: number;
  minutes: number;
  buffer?: number;
  gender?: 'unisex' | 'female' | 'male';
  expertise: string[];
  /** Relative popularity for generated history. */
  weight: number;
}

const HAIR = ['Hair Artist', 'Senior Hair Artist', 'Hair Stylist'];
export const SERVICES: ServiceSeed[] = [
  { code: 'HC-W', name: 'Haircut (Women)', category: 'Hair', price: 70000, minutes: 45, gender: 'female', expertise: HAIR, weight: 10 },
  { code: 'HC-M', name: 'Haircut (Men)', category: 'Hair', price: 35000, minutes: 30, gender: 'male', expertise: [...HAIR, 'Barber'], weight: 10 },
  { code: 'HSPA', name: 'Hair Spa', category: 'Hair', price: 120000, minutes: 60, buffer: 10, expertise: HAIR, weight: 8 },
  { code: 'HCOL', name: 'Hair Coloring', category: 'Hair', price: 250000, minutes: 90, buffer: 10, expertise: ['Colorist', 'Senior Hair Artist'], weight: 4 },
  { code: 'HSTY', name: 'Hair Styling', category: 'Hair', price: 80000, minutes: 45, expertise: HAIR, weight: 3 },
  { code: 'KERA', name: 'Keratin Treatment', category: 'Hair', price: 450000, minutes: 150, buffer: 15, expertise: ['Senior Hair Artist', 'Colorist'], weight: 1 },
  { code: 'BEARD', name: 'Beard Trim', category: 'Grooming', price: 20000, minutes: 20, gender: 'male', expertise: ['Barber'], weight: 5 },
  { code: 'BLOW', name: 'Blow Dry', category: 'Hair', price: 50000, minutes: 30, expertise: HAIR, weight: 3 },
  { code: 'FACE', name: 'Facial', category: 'Skin', price: 150000, minutes: 60, buffer: 10, expertise: ['Facial Specialist', 'Skin Specialist'], weight: 7 },
  { code: 'CLNP', name: 'Cleanup', category: 'Skin', price: 80000, minutes: 40, expertise: ['Facial Specialist', 'Skin Specialist'], weight: 6 },
  { code: 'DTAN', name: 'De-tan', category: 'Skin', price: 60000, minutes: 30, expertise: ['Skin Specialist', 'Facial Specialist'], weight: 3 },
  { code: 'HEADM', name: 'Head Massage', category: 'Massage', price: 50000, minutes: 30, expertise: ['Masseuse'], weight: 4 },
  { code: 'BODYM', name: 'Body Massage', category: 'Massage', price: 200000, minutes: 60, buffer: 10, expertise: ['Masseuse'], weight: 3 },
  { code: 'FOOTR', name: 'Foot Reflexology', category: 'Massage', price: 90000, minutes: 40, expertise: ['Masseuse'], weight: 2 },
  { code: 'MANI', name: 'Manicure', category: 'Nails', price: 70000, minutes: 40, expertise: ['Nail Artist'], weight: 5 },
  { code: 'PEDI', name: 'Pedicure', category: 'Nails', price: 90000, minutes: 50, expertise: ['Nail Artist'], weight: 5 },
  { code: 'NART', name: 'Nail Art', category: 'Nails', price: 60000, minutes: 30, expertise: ['Nail Artist'], weight: 2 },
  { code: 'PMKP', name: 'Party Makeup', category: 'Makeup', price: 500000, minutes: 60, buffer: 10, expertise: ['Makeup Artist'], weight: 2 },
  { code: 'BMKP', name: 'Bridal Makeup', category: 'Makeup', price: 1200000, minutes: 120, buffer: 15, expertise: ['Makeup Artist'], weight: 0.4 },
  { code: 'WAXA', name: 'Full Arms Waxing', category: 'Grooming', price: 40000, minutes: 20, gender: 'female', expertise: ['Skin Specialist', 'Nail Artist'], weight: 4 },
];

export interface StaffSeed {
  branch: 'RJT' | 'AMD';
  code: string;
  name: string;
  display: string;
  designation: string;
  gender: 'female' | 'male';
  expertise: string[];
  color: string;
  weeklyOff: number;
  punchId: string;
  mobile: string;
}

export const STAFF: StaffSeed[] = [
  { branch: 'RJT', code: 'RJ001', name: 'Rahul Shah', display: 'Rahul', designation: 'Hair Artist', gender: 'male', expertise: ['Hair Artist', 'Hair Stylist', 'Colorist'], color: '#6366f1', weeklyOff: 2, punchId: '1001', mobile: '9898000001' },
  { branch: 'RJT', code: 'RJ002', name: 'Priya Mehta', display: 'Priya', designation: 'Makeup Artist', gender: 'female', expertise: ['Makeup Artist'], color: '#ec4899', weeklyOff: 3, punchId: '1002', mobile: '9898000002' },
  { branch: 'RJT', code: 'RJ003', name: 'Neha Joshi', display: 'Neha', designation: 'Masseuse', gender: 'female', expertise: ['Masseuse'], color: '#14b8a6', weeklyOff: 1, punchId: '1003', mobile: '9898000003' },
  { branch: 'RJT', code: 'RJ004', name: 'Amit Patel', display: 'Amit', designation: 'Hair Stylist', gender: 'male', expertise: ['Hair Stylist', 'Barber'], color: '#f59e0b', weeklyOff: 4, punchId: '1004', mobile: '9898000004' },
  { branch: 'RJT', code: 'RJ005', name: 'Kajal Desai', display: 'Kajal', designation: 'Nail Artist', gender: 'female', expertise: ['Nail Artist'], color: '#f43f5e', weeklyOff: 5, punchId: '1005', mobile: '9898000005' },
  { branch: 'RJT', code: 'RJ006', name: 'Sneha Trivedi', display: 'Sneha', designation: 'Skin Specialist', gender: 'female', expertise: ['Skin Specialist', 'Facial Specialist'], color: '#8b5cf6', weeklyOff: 2, punchId: '1006', mobile: '9898000006' },
  { branch: 'AMD', code: 'AH001', name: 'Vikram Solanki', display: 'Vikram', designation: 'Barber', gender: 'male', expertise: ['Barber', 'Hair Artist'], color: '#0ea5e9', weeklyOff: 1, punchId: '2001', mobile: '9898000011' },
  { branch: 'AMD', code: 'AH002', name: 'Pooja Vyas', display: 'Pooja', designation: 'Senior Hair Artist', gender: 'female', expertise: ['Senior Hair Artist', 'Colorist', 'Hair Stylist'], color: '#d946ef', weeklyOff: 3, punchId: '2002', mobile: '9898000012' },
  { branch: 'AMD', code: 'AH003', name: 'Riya Shah', display: 'Riya', designation: 'Facial Specialist', gender: 'female', expertise: ['Facial Specialist', 'Skin Specialist'], color: '#10b981', weeklyOff: 2, punchId: '2003', mobile: '9898000013' },
  { branch: 'AMD', code: 'AH004', name: 'Karan Modi', display: 'Karan', designation: 'Masseur', gender: 'male', expertise: ['Masseuse'], color: '#3b82f6', weeklyOff: 4, punchId: '2004', mobile: '9898000014' },
  { branch: 'AMD', code: 'AH005', name: 'Nisha Parikh', display: 'Nisha', designation: 'Makeup & Nail Artist', gender: 'female', expertise: ['Makeup Artist', 'Nail Artist'], color: '#ef4444', weeklyOff: 5, punchId: '2005', mobile: '9898000015' },
];

export const BRANCHES = [
  { code: 'RJT', name: 'Glow Rajkot', city: 'Rajkot', address: '12, Kalawad Road, Rajkot', phone: '9898100001' },
  { code: 'AMD', name: 'Glow Ahmedabad', city: 'Ahmedabad', address: '45, CG Road, Navrangpura, Ahmedabad', phone: '9898100002' },
] as const;

export const DEMO_PASSWORD = 'Welcome@2026';

/** Deterministic PRNG so every seed run produces the same salon. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
    weighted: <T extends { weight: number }>(items: readonly T[]): T => {
      const total = items.reduce((a, i) => a + i.weight, 0);
      let r = next() * total;
      for (const i of items) {
        r -= i.weight;
        if (r <= 0) return i;
      }
      return items[items.length - 1]!;
    },
  };
}
