import { query } from "../db.js";

export interface NewUserRecord {
  category: "trip" | "warranty" | "home_service" | "subscription" | "vehicle" | "other";
  vendorName: string;
  confirmationNumber: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  time: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  amount: string | null;
  notes: string | null;
  rawSnippet: string | null;
}

export async function insertUserRecord(
  userName: string,
  record: NewUserRecord
): Promise<void> {
  await query(
    `INSERT INTO user_records
       (user_name, category, vendor_name, confirmation_number,
        date_start, date_end, time, address, phone, website,
        amount, notes, raw_email_snippet)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      userName,
      record.category,
      record.vendorName,
      record.confirmationNumber,
      record.dateStart,
      record.dateEnd,
      record.time,
      record.address,
      record.phone,
      record.website,
      record.amount,
      record.notes,
      record.rawSnippet,
    ]
  );
}
