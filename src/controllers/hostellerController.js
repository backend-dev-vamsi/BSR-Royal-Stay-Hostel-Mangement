import pool from "../config/database.js";
import { sendErrorResponse, sendSuccessResponse } from "../utils/response.js";

const PHONE_REGEX = /^\d{10}$/;
const AADHAR_REGEX = /^\d{12}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const FEE_PLANS = ["Monthly", "Day-wise"];
const HOSTELLER_STATUSES = ["Staying", "Vacating", "Vacated"];

const VACATING_REASONS = [
  "Course completed",
  "Job/relocation",
  "Shifted to another hostel",
  "Personal reasons",
  "Others",
];

const PERSONAL_FIELDS = [
  "full_name",
  "aadhar_number",
  "phone_number",
  "address",
  "emergency_contact_number",
  "fee_plan",
  "join_date",
  "number_of_days",
];

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isValidDate(value) {
  if (typeof value !== "string" || !DATE_REGEX.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function validatePersonalData(data, isCreate = false) {
  const errors = [];

  if (
    isCreate &&
    (!data.full_name ||
      !data.aadhar_number ||
      !data.phone_number ||
      !data.join_date ||
      !data.fee_plan)
  ) {
    errors.push(
      "full_name, aadhar_number, phone_number, join_date and fee_plan are required",
    );
  }

  if (
    data.full_name !== undefined &&
    (typeof data.full_name !== "string" ||
      !data.full_name.trim() ||
      data.full_name.trim().length > 150)
  ) {
    errors.push(
      "full_name must be a non-empty string of at most 150 characters",
    );
  }

  if (
    data.aadhar_number !== undefined &&
    !AADHAR_REGEX.test(String(data.aadhar_number))
  ) {
    errors.push("aadhar_number must contain exactly 12 digits");
  }

  if (
    data.phone_number !== undefined &&
    !PHONE_REGEX.test(String(data.phone_number))
  ) {
    errors.push("phone_number must contain exactly 10 digits");
  }

  if (
    data.emergency_contact_number !== undefined &&
    data.emergency_contact_number !== null &&
    data.emergency_contact_number !== "" &&
    !PHONE_REGEX.test(String(data.emergency_contact_number))
  ) {
    errors.push("emergency_contact_number must contain exactly 10 digits");
  }

  if (data.join_date !== undefined && !isValidDate(data.join_date)) {
    errors.push("join_date must be a valid date in YYYY-MM-DD format");
  }

  if (data.fee_plan !== undefined && !FEE_PLANS.includes(data.fee_plan)) {
    errors.push("fee_plan must be Monthly or Day-wise");
  }

  if (data.fee_plan === "Day-wise") {
    if (
      !Number.isInteger(Number(data.number_of_days)) ||
      Number(data.number_of_days) < 1 ||
      Number(data.number_of_days) > 365
    ) {
      errors.push(
        "number_of_days must be between 1 and 365 for Day-wise plans",
      );
    }
  } else if (
    data.fee_plan !== undefined &&
    data.number_of_days !== undefined &&
    data.number_of_days !== null &&
    data.number_of_days !== ""
  ) {
    errors.push("number_of_days must only be provided for Day-wise plans");
  }

  if (
    data.address !== undefined &&
    data.address !== null &&
    typeof data.address !== "string"
  ) {
    errors.push("address must be a string");
  }

  return errors;
}

function validateId(id) {
  return /^\d+$/.test(String(id)) && Number(id) > 0;
}

function getHostellerId(req, res) {
  const id = req.params.hostellerId;

  if (!validateId(id)) {
    sendErrorResponse(res, 400, "Invalid hosteller ID");
    return null;
  }

  return Number(id);
}

function getTodayDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const date = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      date[part.type] = part.value;
    }
  }

  return `${date.year}-${date.month}-${date.day}`;
}

function normalizeDateOnly(value) {
  if (value instanceof Date) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, "0"),
      String(value.getUTCDate()).padStart(2, "0"),
    ].join("-");
  }

  return String(value).slice(0, 10);
}

async function getRoomForAllocation(client, roomId) {
  const result = await client.query(
    `SELECT room_id, sharing_type, status
         FROM tbl_rooms
         WHERE room_id = $1
         FOR UPDATE`,
    [roomId],
  );

  if (result.rows.length === 0) {
    fail(404, "Room not found");
  }

  const room = result.rows[0];

  if (room.status !== "ACTIVE") {
    fail(400, "This room is not available for allocation");
  }

  const capacity = Number(room.sharing_type);

  if (!Number.isInteger(capacity) || capacity < 1) {
    fail(400, "Room sharing capacity is invalid");
  }

  const countResult = await client.query(
    `SELECT COUNT(*)::INTEGER AS occupied_beds
         FROM tbl_room_allocations
         WHERE room_id = $1
           AND status = 'ACTIVE'`,
    [roomId],
  );

  return {
    capacity,
    occupiedBeds: countResult.rows[0].occupied_beds,
  };
}

async function ensureRoomHasSpace(client, roomId) {
  const room = await getRoomForAllocation(client, roomId);

  if (room.occupiedBeds >= room.capacity) {
    fail(409, "This room is full");
  }
}

async function getHostellerStatus(client, hostellerId, lock = false) {
  const result = await client.query(
    `SELECT
    hosteller_id,
    status,
    join_date,
    fee_plan,
    number_of_days
 FROM tbl_hostellers
 WHERE hosteller_id = $1
 ${lock ? "FOR UPDATE" : ""}`,
    [hostellerId],
  );

  if (result.rows.length === 0) {
    fail(404, "Hosteller not found");
  }

  return result.rows[0];
}


// POST /hostellers
export const createHosteller = async (req, res) => {
    const {
        full_name,
        aadhar_number,
        phone_number,
        address,
        emergency_contact_number,
        building_id,
        floor,
        room_no,
        fee_plan,
        number_of_days,
        join_date
    } = req.body;

    // Validate Day-wise number of days
    if (
        fee_plan === "Day-wise" &&
        (
            !Number.isInteger(number_of_days) ||
            number_of_days < 1 ||
            number_of_days > 365
        )
    ) {
        return sendErrorResponse(
            res,
            400,
            "For Day-wise fee plan, number_of_days must be between 1 and 365."
        );
    }

    // Monthly plan should not have number_of_days
    if (
        fee_plan === "Monthly" &&
        number_of_days != null
    ) {
        return sendErrorResponse(
            res,
            400,
            "number_of_days is only allowed for Day-wise fee plan."
        );
    }

    // Validate request body
    if (
        typeof full_name !== "string" ||
        !full_name.trim() ||
        typeof aadhar_number !== "string" ||
        !/^\d{12}$/.test(aadhar_number) ||
        typeof phone_number !== "string" ||
        !/^\d{10}$/.test(phone_number) ||
        (address != null && typeof address !== "string") ||
        (
            emergency_contact_number != null &&
            emergency_contact_number !== "" &&
            (
                typeof emergency_contact_number !== "string" ||
                !/^\d{10}$/.test(emergency_contact_number)
            )
        ) ||
        !Number.isInteger(Number(building_id)) ||
        Number(building_id) <= 0 ||
        typeof floor !== "string" ||
        !floor.trim() ||
        typeof room_no !== "string" ||
        !room_no.trim() ||
        !["Monthly", "Day-wise"].includes(fee_plan) ||
        !join_date ||
        !isValidDate(join_date)
    ) {
        return sendErrorResponse(
            res,
            400,
            "Please provide valid hosteller and room details."
        );
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query("BEGIN");
        transactionStarted = true;

        // Find and lock selected room
        const roomResult = await client.query(
            `SELECT
                r.room_id,
                r.building_id,
                r.floor,
                r.room_number,
                r.sharing_type,
                r.monthly_cost,
                r.beds_filled,
                b.building_name
             FROM tbl_rooms r
             JOIN tbl_buildings b
                ON b.building_id = r.building_id
             WHERE r.building_id = $1
               AND LOWER(TRIM(r.floor)) = LOWER(TRIM($2))
               AND LOWER(TRIM(r.room_number)) = LOWER(TRIM($3))
               AND r.status = 'ACTIVE'
               AND b.status = 'ACTIVE'
             FOR UPDATE OF r`,
            [Number(building_id), floor.trim(), room_no.trim()]
        );

        if (roomResult.rowCount === 0) {
            fail(404, "Selected room not found or inactive.");
        }

        const room = roomResult.rows[0];

        // Check room availability
        const occupiedResult = await client.query(
            `SELECT COUNT(*)::INTEGER AS occupied_beds
             FROM tbl_room_allocations
             WHERE room_id = $1
               AND status = 'ACTIVE'`,
            [room.room_id]
        );

        const occupiedBeds = occupiedResult.rows[0].occupied_beds;

        if (occupiedBeds >= room.sharing_type) {
            fail(409, "Selected room is already full.");
        }

        // Register hosteller
        const hostellerResult = await client.query(
            `INSERT INTO tbl_hostellers (
                full_name,
                aadhar_number,
                phone_number,
                address,
                emergency_contact_number,
                join_date,
                fee_plan,
                number_of_days,
                status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Staying')
            RETURNING *`,
            [
                full_name.trim(),
                aadhar_number,
                phone_number,
                address?.trim() || null,
                emergency_contact_number || null,
                join_date,
                fee_plan,
                fee_plan === "Day-wise" ? number_of_days : null
            ]
        );

        const hosteller = hostellerResult.rows[0];

        // Allocate room
        const allocationResult = await client.query(
            `INSERT INTO tbl_room_allocations (
                room_id,
                hosteller_id,
                allocation_date,
                status
            )
            VALUES ($1, $2, $3, 'ACTIVE')
            RETURNING *`,
            [room.room_id, hosteller.hosteller_id, join_date]
        );

        // Update filled beds
        await client.query(
            `UPDATE tbl_rooms
             SET beds_filled = $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE room_id = $2`,
            [occupiedBeds + 1, room.room_id]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return sendSuccessResponse(
            res,
            201,
            "Hosteller registered and room allocated successfully",
            {
                hosteller,
                allocation: allocationResult.rows[0],
                room: {
                    building_id: room.building_id,
                    building_name: room.building_name,
                    floor: room.floor,
                    room_no: room.room_number,
                    sharing_type: room.sharing_type,
                    monthly_cost: room.monthly_cost,
                    beds_filled: occupiedBeds + 1,
                    available_beds: room.sharing_type - (occupiedBeds + 1)
                }
            }
        );

    } catch (error) {
        if (transactionStarted) {
            await client.query("ROLLBACK");
        }

        if (error.code === "23505") {
            return sendErrorResponse(
                res,
                409,
                "Hosteller with this Aadhar number already exists."
            );
        }

        if (error.code === "23503") {
            return sendErrorResponse(
                res,
                400,
                "Invalid building or room reference."
            );
        }

        console.error("Create hosteller error:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status ? error.message : "Internal server error"
        );

    } finally {
        client.release();
    }
};

// GET /hostellers
export async function getAllHostellers(req, res) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Automatically update due vacating hostellers
        await finalizeDueVacatings(client);

        const { status, search } = req.query;

        // Validate status
        if (
            status &&
            !HOSTELLER_STATUSES.includes(status)
        ) {
            fail(
                400,
                "status must be Staying, Vacating or Vacated"
            );
        }

        const values = [];
        const conditions = [];

        // Status filter
        if (status) {
            values.push(status);

            conditions.push(
                `h.status = $${values.length}`
            );
        }

        // Search filter
        if (search && String(search).trim()) {
            values.push(`%${String(search).trim()}%`);

            const index = values.length;

            conditions.push(`(
                h.full_name ILIKE $${index}
                OR h.phone_number ILIKE $${index}
                OR h.aadhar_number ILIKE $${index}
                OR r.room_number::TEXT ILIKE $${index}
                OR r.floor ILIKE $${index}
                OR b.building_name ILIKE $${index}
            )`);
        }

        const whereClause = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

        // Fetch hostellers
        const result = await client.query(
            `SELECT
                h.hosteller_id,
                h.full_name,
                h.aadhar_number,
                h.phone_number,
                h.address,
                h.emergency_contact_number,
                h.join_date,
                h.fee_plan,
                h.number_of_days,
                h.status,
                h.vacating_date,
                h.vacating_reason,
                h.vacating_remarks,
                h.created_at,

                r.room_id,
                r.room_number,
                r.floor,
                r.sharing_type,

                b.building_id,
                b.building_name,

                ra.allocation_id,
                ra.allocation_date,
                ra.vacated_date,
                ra.status AS allocation_status

            FROM tbl_hostellers h

            LEFT JOIN LATERAL (
                SELECT
                    allocation_id,
                    room_id,
                    allocation_date,
                    vacated_date,
                    status
                FROM tbl_room_allocations
                WHERE hosteller_id = h.hosteller_id
                ORDER BY
                    allocation_date DESC,
                    allocation_id DESC
                LIMIT 1
            ) ra ON TRUE

            LEFT JOIN tbl_rooms r
                ON r.room_id = ra.room_id

            LEFT JOIN tbl_buildings b
                ON b.building_id = r.building_id

            ${whereClause}

            ORDER BY h.created_at DESC`,
            values
        );

        await client.query("COMMIT");

        // Return complete Aadhar number without masking
        const hostellers = result.rows;

        return sendSuccessResponse(
            res,
            200,
            "Hostellers fetched successfully",
            hostellers
        );

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("getAllHostellers:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status
                ? error.message
                : "Failed to fetch hostellers"
        );

    } finally {
        client.release();
    }
}

// GET /hostellers/:hostellerId
export async function getHostellerById(req, res) {
    const hostellerId = getHostellerId(req, res);

    if (!hostellerId) return;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Automatically update due vacating hostellers
        await finalizeDueVacatings(client);

        const result = await client.query(
            `SELECT
                h.*,

                ra.allocation_id,
                ra.room_id,
                ra.allocation_date,
                ra.vacated_date,
                ra.status AS allocation_status,

                r.room_number,
                r.floor,
                r.sharing_type,

                b.building_id,
                b.building_name

             FROM tbl_hostellers h

             LEFT JOIN LATERAL (
                 SELECT *
                 FROM tbl_room_allocations
                 WHERE hosteller_id = h.hosteller_id
                 ORDER BY
                     allocation_date DESC,
                     allocation_id DESC
                 LIMIT 1
             ) ra ON TRUE

             LEFT JOIN tbl_rooms r
                ON r.room_id = ra.room_id

             LEFT JOIN tbl_buildings b
                ON b.building_id = r.building_id

             WHERE h.hosteller_id = $1`,
            [hostellerId]
        );

        if (!result.rows.length) {
            await client.query("ROLLBACK");

            return sendErrorResponse(
                res,
                404,
                "Hosteller not found"
            );
        }

        await client.query("COMMIT");

        // Return complete Aadhar number without masking
        const hosteller = result.rows[0];

        return sendSuccessResponse(
            res,
            200,
            "Hosteller fetched successfully",
            hosteller
        );

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("getHostellerById:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status
                ? error.message
                : "Failed to fetch hosteller"
        );

    } finally {
        client.release();
    }
}

// Update beds_filled count
async function updateRoomBedsFilled(client, roomId) {
  await client.query(
    `UPDATE tbl_rooms
         SET beds_filled = (
             SELECT COUNT(*)::INTEGER
             FROM tbl_room_allocations
             WHERE room_id = $1
               AND status = 'ACTIVE'
         ),
         updated_at = CURRENT_TIMESTAMP
         WHERE room_id = $1`,
    [roomId],
  );
}

// Automatically finalize scheduled vacating without Cron
async function finalizeDueVacatings(client) {
    const today = getTodayDate();

    // Lock hostellers whose vacating date has arrived
    const dueResult = await client.query(
        `SELECT hosteller_id, vacating_date
         FROM tbl_hostellers
         WHERE status = 'Vacating'
           AND vacating_date <= $1
         FOR UPDATE`,
        [today]
    );

    if (!dueResult.rows.length) {
        return 0;
    }

    const hostellerIds = dueResult.rows.map(
        (row) => row.hosteller_id
    );

    // Release active room allocations
    const allocationResult = await client.query(
        `UPDATE tbl_room_allocations ra
         SET status = 'VACATED',
             vacated_date = h.vacating_date,
             updated_at = CURRENT_TIMESTAMP
         FROM tbl_hostellers h
         WHERE ra.hosteller_id = h.hosteller_id
           AND ra.hosteller_id = ANY($1::INTEGER[])
           AND ra.status = 'ACTIVE'
         RETURNING ra.room_id`,
        [hostellerIds]
    );

    // Update hosteller statuses
    await client.query(
        `UPDATE tbl_hostellers
         SET status = 'Vacated',
             updated_at = CURRENT_TIMESTAMP
         WHERE hosteller_id = ANY($1::INTEGER[])`,
        [hostellerIds]
    );

    // Get affected room IDs
    const roomIds = [
        ...new Set(
            allocationResult.rows.map(
                (row) => Number(row.room_id)
            )
        )
    ];

    // Recalculate beds_filled
    if (roomIds.length) {
        await client.query(
            `UPDATE tbl_rooms r
             SET beds_filled = (
                 SELECT COUNT(*)::INTEGER
                 FROM tbl_room_allocations ra
                 WHERE ra.room_id = r.room_id
                   AND ra.status = 'ACTIVE'
             ),
             updated_at = CURRENT_TIMESTAMP
             WHERE r.room_id = ANY($1::INTEGER[])`,
            [roomIds]
        );
    }

    return hostellerIds.length;
}

// PUT /hostellers/:hostellerId
// Update personal, fee, joining and room details
export async function updateHosteller(req, res) {
    const hostellerId = getHostellerId(req, res);

    if (!hostellerId) return;

    const data = req.body || {};
    const keys = Object.keys(data);

    if (!keys.length) {
        return sendErrorResponse(res, 400, "Provide at least one field to update");
    }

    // Check allowed fields
    const forbidden = keys.filter(
        (key) =>
            !PERSONAL_FIELDS.includes(key) &&
            !["room_id", "allocation_date"].includes(key)
    );

    if (forbidden.length) {
        return sendErrorResponse(
            res,
            400,
            `These fields cannot be updated here: ${forbidden.join(", ")}`
        );
    }

    const allowed = PERSONAL_FIELDS.filter((field) =>
        Object.hasOwn(data, field)
    );

    const roomRequested = Object.hasOwn(data, "room_id");
    const allocationDateRequested = Object.hasOwn(data, "allocation_date");
    const joinDateRequested = Object.hasOwn(data, "join_date");

    if (allocationDateRequested && !roomRequested) {
        return sendErrorResponse(
            res,
            400,
            "room_id is required when updating allocation_date"
        );
    }

    // Validate personal fields
    const errors = validatePersonalData(data);

    if (errors.length) {
        return sendErrorResponse(res, 400, "Validation failed", errors);
    }

    // Validate room fields
    if (roomRequested && !isPositiveInteger(data.room_id)) {
        return sendErrorResponse(res, 400, "A valid room_id is required");
    }

    if (
        allocationDateRequested &&
        !isValidDate(data.allocation_date)
    ) {
        return sendErrorResponse(
            res,
            400,
            "allocation_date must be a valid YYYY-MM-DD date"
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const today = getTodayDate();

        // Lock hosteller
        const current = await getHostellerStatus(client, hostellerId, true);

        if (!current) {
            fail(404, "Hosteller not found");
        }

        if (current.status !== "Staying") {
            fail(400, "Only staying hostellers can be updated");
        }

        // Calculate final joining date
        const nextJoinDate = normalizeDateOnly(
            data.join_date ?? current.join_date
        );

        // Calculate final fee details
        const nextFeePlan = data.fee_plan ?? current.fee_plan;

        const nextDays = Object.hasOwn(data, "number_of_days")
            ? data.number_of_days
            : Object.hasOwn(data, "fee_plan") && data.fee_plan !== "Day-wise"
                ? null
                : current.number_of_days;

        // Validate joining date
        if (joinDateRequested) {
            if (!isValidDate(nextJoinDate)) {
                fail(400, "join_date must be a valid YYYY-MM-DD date");
            }

            if (nextJoinDate > today) {
                fail(400, `join_date cannot be in the future. Today is ${today}`);
            }

            const allocationResult = await client.query(
                `SELECT allocation_date
                 FROM tbl_room_allocations
                 WHERE hosteller_id = $1
                 ORDER BY allocation_date ASC
                 LIMIT 1`,
                [hostellerId]
            );

            if (allocationResult.rows.length) {
                const firstAllocationDate = normalizeDateOnly(
                    allocationResult.rows[0].allocation_date
                );

                if (nextJoinDate > firstAllocationDate) {
                    fail(
                        400,
                        "join_date cannot be later than the first room allocation date"
                    );
                }
            }
        }

        // Validate Day-wise plan
        if (
            nextFeePlan === "Day-wise" &&
            (!isPositiveInteger(nextDays) || Number(nextDays) > 365)
        ) {
            fail(
                400,
                "Day-wise fee plans require number_of_days between 1 and 365"
            );
        }

        if (
            nextFeePlan !== "Day-wise" &&
            Object.hasOwn(data, "number_of_days") &&
            data.number_of_days != null
        ) {
            fail(400, "number_of_days is only valid for a Day-wise plan");
        }

        const finalDays =
            nextFeePlan === "Day-wise" ? Number(nextDays) : null;

        let oldRoomId = null;
        let newRoomId = null;
        let updatedAllocation = null;
        let roomChanged = false;

        // Handle room selection/change
        if (roomRequested) {
            const currentAllocationResult = await client.query(
                `SELECT
                    allocation_id,
                    room_id,
                    allocation_date
                 FROM tbl_room_allocations
                 WHERE hosteller_id = $1
                   AND status = 'ACTIVE'
                 FOR UPDATE`,
                [hostellerId]
            );

            if (!currentAllocationResult.rows.length) {
                fail(409, "No active room allocation exists for this hosteller");
            }

            const currentAllocation = currentAllocationResult.rows[0];

            oldRoomId = Number(currentAllocation.room_id);
            newRoomId = Number(data.room_id);

            // Same room: do not create another allocation.
            // Continue updating personal and fee details.
            if (oldRoomId !== newRoomId) {
                roomChanged = true;

                const newAllocationDate = data.allocation_date || today;

                const currentAllocationDate = normalizeDateOnly(
                    currentAllocation.allocation_date
                );

                if (newAllocationDate > today) {
                    fail(400, "allocation_date cannot be in the future");
                }

                if (
                    newAllocationDate < currentAllocationDate ||
                    newAllocationDate < nextJoinDate
                ) {
                    fail(
                        400,
                        "New allocation date cannot be earlier than the current allocation or join date"
                    );
                }

                // Check and lock new room
                await ensureRoomHasSpace(client, newRoomId);

                // Close previous allocation
                await client.query(
                    `UPDATE tbl_room_allocations
                     SET status = 'VACATED',
                         vacated_date = $1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE allocation_id = $2`,
                    [newAllocationDate, currentAllocation.allocation_id]
                );

                // Create new allocation
                const allocationResult = await client.query(
                    `INSERT INTO tbl_room_allocations (
                        room_id,
                        hosteller_id,
                        allocation_date,
                        status
                    )
                    VALUES ($1, $2, $3, 'ACTIVE')
                    RETURNING *`,
                    [newRoomId, hostellerId, newAllocationDate]
                );

                updatedAllocation = allocationResult.rows[0];

                // Update room bed counts
                await updateRoomBedsFilled(client, oldRoomId);
                await updateRoomBedsFilled(client, newRoomId);
            } else {
                // Same room: return existing allocation
                updatedAllocation = currentAllocation;
            }
        }

        // Update personal and fee details
        const values = [];
        const assignments = [];

        for (const field of allowed) {
            let value = data[field];

            if (field === "full_name") {
                value = value.trim();
            }

            if (field === "fee_plan") {
                value = nextFeePlan;
            }

            if (field === "join_date") {
                value = nextJoinDate;
            }

            if (field === "number_of_days") {
                value = finalDays;
            }

            if (
                field === "address" ||
                field === "emergency_contact_number"
            ) {
                value = value === "" ? null : value;
            }

            values.push(value);
            assignments.push(`${field} = $${values.length}`);
        }

        // Update number_of_days when fee_plan changes
        if (
            !allowed.includes("number_of_days") &&
            allowed.includes("fee_plan")
        ) {
            values.push(finalDays);
            assignments.push(`number_of_days = $${values.length}`);
        }

        let updatedHosteller = current;

        if (assignments.length) {
            values.push(hostellerId);

            const updateResult = await client.query(
                `UPDATE tbl_hostellers
                 SET ${assignments.join(", ")},
                     updated_at = CURRENT_TIMESTAMP
                 WHERE hosteller_id = $${values.length}
                 RETURNING *`,
                values
            );

            updatedHosteller = updateResult.rows[0];
        } else if (!roomRequested) {
            fail(400, "Provide at least one field to update");
        }

        await client.query("COMMIT");

        return sendSuccessResponse(
            res,
            200,
            roomChanged
                ? "Hosteller details and room updated successfully"
                : "Hosteller details updated successfully",
            {
                hosteller: updatedHosteller,
                allocation: updatedAllocation
            }
        );

    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return sendErrorResponse(
                res,
                409,
                "A hosteller with this Aadhar number already exists"
            );
        }

        console.error("updateHosteller:", error);

        return sendErrorResponse(
            res,
            error.status || 500,
            error.status ? error.message : "Failed to update hosteller"
        );
    } finally {
        client.release();
    }
}


// PATCH /hostellers/:hostellerId/vacate
export async function vacateHosteller(req, res) {
  const hostellerId = getHostellerId(req, res);
  if (!hostellerId) return;

  const {
    vacating_date: vacatingDate,
    vacating_reason: vacatingReason,
    vacating_remarks: vacatingRemarks,
  } = req.body || {};

  if (!isValidDate(vacatingDate)) {
    return sendErrorResponse(
      res,
      400,
      "vacating_date is required in YYYY-MM-DD format",
    );
  }

  if (!VACATING_REASONS.includes(vacatingReason)) {
    return sendErrorResponse(
      res,
      400,
      `vacating_reason must be one of: ${VACATING_REASONS.join(", ")}`,
    );
  }

  if (
    vacatingReason === "Other" &&
    (!vacatingRemarks || !String(vacatingRemarks).trim())
  ) {
    return sendErrorResponse(
      res,
      400,
      "vacating_remarks is required when vacating_reason is Other",
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const today = getTodayDate();

    // Lock hosteller
    const hosteller = await getHostellerStatus(client, hostellerId, true);

    if (hosteller.status !== "Staying") {
      fail(400, "Only staying hostellers can request vacating");
    }

    const joinDate = normalizeDateOnly(hosteller.join_date);

    if (vacatingDate < joinDate) {
      fail(400, "vacating_date cannot be earlier than join_date");
    }

    const allocationResult = await client.query(
      `SELECT
                allocation_id,
                room_id,
                allocation_date
             FROM tbl_room_allocations
             WHERE hosteller_id = $1
               AND status = 'ACTIVE'
             FOR UPDATE`,
      [hostellerId],
    );

    if (!allocationResult.rows.length) {
      fail(409, "No active room allocation exists for this hosteller");
    }

    const allocation = allocationResult.rows[0];

    const allocationDate = normalizeDateOnly(allocation.allocation_date);

    if (vacatingDate < allocationDate) {
      fail(400, "vacating_date cannot be earlier than allocation_date");
    }

    // Determine status from vacating date
    const isFutureVacating = vacatingDate > today;

    const nextStatus = isFutureVacating ? "Vacating" : "Vacated";

    // Release room only when vacating date is reached
    if (!isFutureVacating) {
      await client.query(
        `UPDATE tbl_room_allocations
                 SET status = 'VACATED',
                     vacated_date = $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE allocation_id = $2`,
        [vacatingDate, allocation.allocation_id],
      );

      await updateRoomBedsFilled(client, allocation.room_id);
    }

    // Update hosteller
    await client.query(
      `UPDATE tbl_hostellers
             SET status = $1,
                 vacating_date = $2,
                 vacating_reason = $3,
                 vacating_remarks = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE hosteller_id = $5`,
      [
        nextStatus,
        vacatingDate,
        vacatingReason,
        vacatingRemarks?.trim() || null,
        hostellerId,
      ],
    );

    // Get updated hosteller with room details
    const result = await client.query(
      `SELECT
                h.hosteller_id,
                h.full_name,
                h.phone_number,
                h.status,
                h.join_date,
                h.vacating_date,
                h.vacating_reason,
                h.vacating_remarks,

                b.building_id,
                b.building_name,
                r.room_id,
                r.floor,
                r.room_number,
                r.sharing_type

             FROM tbl_hostellers h

             LEFT JOIN LATERAL (
                 SELECT ra.room_id
                 FROM tbl_room_allocations ra
                 WHERE ra.hosteller_id = h.hosteller_id
                 ORDER BY ra.allocation_date DESC,
                          ra.allocation_id DESC
                 LIMIT 1
             ) latest_allocation ON TRUE

             LEFT JOIN tbl_rooms r
                ON r.room_id = latest_allocation.room_id

             LEFT JOIN tbl_buildings b
                ON b.building_id = r.building_id

             WHERE h.hosteller_id = $1`,
      [hostellerId],
    );

    await client.query("COMMIT");

    return sendSuccessResponse(
      res,
      200,
      isFutureVacating
        ? "Hosteller vacating scheduled successfully"
        : "Hosteller vacated successfully and room bed released",
      result.rows[0],
    );
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("vacateHosteller:", error);

    return sendErrorResponse(
      res,
      error.status || 500,
      error.status ? error.message : "Failed to vacate hosteller",
    );
  } finally {
    client.release();
  }
}

// GET /hostellers/:hostellerId/allocations
export async function getHostellerAllocationHistory(req, res) {
  const hostellerId = getHostellerId(req, res);
  if (!hostellerId) return;

  try {
    const hostellerResult = await pool.query(
      `SELECT hosteller_id, full_name
             FROM tbl_hostellers
             WHERE hosteller_id = $1`,
      [hostellerId],
    );

    if (!hostellerResult.rows.length) {
      return sendErrorResponse(res, 404, "Hosteller not found");
    }

    const result = await pool.query(
      `SELECT
                ra.allocation_id,
                ra.room_id,
                r.room_number,
                r.floor,
                b.building_name,
                ra.allocation_date,
                ra.vacated_date,
                ra.status,
                ra.created_at
             FROM tbl_room_allocations ra
             JOIN tbl_rooms r ON r.room_id = ra.room_id
             LEFT JOIN tbl_buildings b ON b.building_id = r.building_id
             WHERE ra.hosteller_id = $1
             ORDER BY ra.allocation_date DESC, ra.allocation_id DESC`,
      [hostellerId],
    );

    return sendSuccessResponse(
      res,
      200,
      "Room allocation history fetched successfully",
      result.rows,
    );
  } catch (error) {
    console.error("getHostellerAllocationHistory:", error);
    return sendErrorResponse(res, 500, "Failed to fetch allocation history");
  }
}

// DELETE /hostellers/:hostellerId
export async function deleteHosteller(req, res) {
  const hostellerId = getHostellerId(req, res);
  if (!hostellerId) return;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Check hosteller exists and lock the record
    const hosteller = await getHostellerStatus(client, hostellerId, true);

    // Allow deletion only for vacated hostellers
    if (hosteller.status !== "Vacated") {
      await client.query("ROLLBACK");

      return sendErrorResponse(
        res,
        409,
        "Cannot delete a hosteller who is currently staying. Vacate the hosteller first.",
      );
    }

    // Delete all room allocation history
    await client.query(
      `DELETE FROM tbl_room_allocations
             WHERE hosteller_id = $1`,
      [hostellerId],
    );

    // Delete the hosteller record
    const result = await client.query(
      `DELETE FROM tbl_hostellers
             WHERE hosteller_id = $1
             RETURNING hosteller_id`,
      [hostellerId],
    );

    await client.query("COMMIT");

    return sendSuccessResponse(
      res,
      200,
      "Hosteller and room allocation history deleted successfully",
      result.rows[0],
    );
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.status === 404) {
      return sendErrorResponse(res, 404, error.message);
    }

    console.error("deleteHosteller:", error);

    return sendErrorResponse(
      res,
      500,
      "Failed to delete hosteller and room allocation history",
    );
  } finally {
    client.release();
  }
}
