
import pool from "../config/database.js";

import {
    sendErrorResponse,
    sendSuccessResponse
} from "../utils/response.js";

const VALID_REPORTS = [
    "current-hostellers",
    "vacated-hostellers",
    "fee-payments",
    "monthly-collection",
    "pending-dues",
    "room-wise",
    "vacant-beds",
    "building-wise"
];

const REPORT_TITLES = {
    "current-hostellers": "Current Hostellers",
    "vacated-hostellers": "Vacated Hostellers",
    "fee-payments": "Fee Payments",
    "monthly-collection": "Monthly Collection",
    "pending-dues": "Pending Dues",
    "room-wise": "Room-wise Report",
    "vacant-beds": "Vacant Beds",
    "building-wise": "Building-wise Report"
};

// Build common search, building and date filters.
function buildFilters(query, options = {}) {
    const {
        searchColumns = [],
        buildingColumn = null,
        dateColumn = null
    } = options;

    const conditions = [];
    const values = [];

    function addCondition(condition, value) {
        values.push(value);
        conditions.push(
            condition.replace("?", `$${values.length}`)
        );
    }

    // Building filter
    if (query.building_id && buildingColumn) {
        addCondition(
            `${buildingColumn} = ?`,
            Number(query.building_id)
        );
    }

    // Search filter
    if (query.search && String(query.search).trim()) {
        const searchValue = `%${String(query.search).trim()}%`;

        const searchConditions = searchColumns.map(column => {
            values.push(searchValue);

            return `COALESCE((${column})::TEXT, '') ILIKE $${values.length}`;
        });

        if (searchConditions.length) {
            conditions.push(`(${searchConditions.join(" OR ")})`);
        }
    }

    // Date filters
    if (dateColumn) {
        const searchBy = query.searchBy;

        if (searchBy === "month" && /^\d{4}-\d{2}$/.test(query.month || "")) {
            addCondition(
                `DATE_TRUNC('month', ${dateColumn}) = DATE_TRUNC('month', ?::DATE)`,
                `${query.month}-01`
            );
        }

        if (searchBy === "year" && /^\d{4}$/.test(query.year || "")) {
            addCondition(
                `EXTRACT(YEAR FROM ${dateColumn}) = ?`,
                Number(query.year)
            );
        }

        if (searchBy === "date-range") {
            if (query.startDate) {
                addCondition(
                    `${dateColumn}::DATE >= ?::DATE`,
                    query.startDate
                );
            }

            if (query.endDate) {
                addCondition(
                    `${dateColumn}::DATE <= ?::DATE`,
                    query.endDate
                );
            }
        }
    }

    return {
        where: conditions.length
            ? ` AND ${conditions.join(" AND ")}`
            : "",
        values
    };
}

// Convert values to CSV-safe strings.
function csvEscape(value) {
    if (value === null || value === undefined) {
        return '""';
    }

    return `"${String(value).replace(/"/g, '""')}"`;
}

function createCsv(records) {
    if (!records.length) {
        return "";
    }

    const columns = Object.keys(records[0]);

    const header = columns
        .map(column => csvEscape(column))
        .join(",");

    const rows = records.map(record =>
        columns
            .map(column => csvEscape(record[column]))
            .join(",")
    );

    return [header, ...rows].join("\n");
}

// Calculate totals before pagination.
function calculateTotals(type, records) {
    const totals = {
        total_records: records.length
    };

    if (type === "fee-payments") {
        totals.total_amount = records.reduce(
            (sum, row) => sum + Number(row.amount || 0),
            0
        );
    }

    if (type === "monthly-collection") {
        totals.total_payments = records.reduce(
            (sum, row) => sum + Number(row.payments || 0),
            0
        );

        totals.total_collected = records.reduce(
            (sum, row) => sum + Number(row.collected || 0),
            0
        );
    }

    if (type === "pending-dues") {
        totals.total_paid = records.reduce(
            (sum, row) => sum + Number(row.paid || 0),
            0
        );

        totals.total_balance = records.reduce(
            (sum, row) => sum + Number(row.balance || 0),
            0
        );
    }

    if (type === "vacant-beds") {
        totals.total_free_beds = records.reduce(
            (sum, row) => sum + Number(row.free_beds || 0),
            0
        );
    }

    if (type === "building-wise") {
        totals.total_rooms = records.reduce(
            (sum, row) => sum + Number(row.rooms || 0),
            0
        );

        totals.total_beds = records.reduce(
            (sum, row) => sum + Number(row.total_beds || 0),
            0
        );

        totals.total_hostellers = records.reduce(
            (sum, row) => sum + Number(row.hostellers || 0),
            0
        );

        totals.total_vacant_beds = records.reduce(
            (sum, row) => sum + Number(row.vacant_beds || 0),
            0
        );
    }

    return totals;
}

// Dropdown filter options.
async function getFilterOptions() {
    const [buildings, feeTypes, paymentModes, years] = await Promise.all([
        pool.query(`
            SELECT
                building_id,
                building_name
            FROM tbl_buildings
            ORDER BY building_name
        `),

        pool.query(`
            SELECT DISTINCT fee_type
            FROM tbl_hostel_fees
            WHERE fee_type IS NOT NULL
            ORDER BY fee_type
        `),

        pool.query(`
            SELECT DISTINCT payment_mode
            FROM tbl_fee_payments
            WHERE payment_mode IS NOT NULL
            ORDER BY payment_mode
        `),

        pool.query(`
            SELECT DISTINCT EXTRACT(YEAR FROM payment_date)::INTEGER AS year
            FROM tbl_fee_payments
            ORDER BY year DESC
        `)
    ]);

    return {
        buildings: buildings.rows,
        feeTypes: feeTypes.rows.map(row => row.fee_type),
        paymentModes: paymentModes.rows.map(row => row.payment_mode),
        years: years.rows.map(row => row.year)
    };
}

export async function getReportController(req, res) {
    try {
        const query = req.query;

        // Default report
        const type = query.type || "current-hostellers";

        if (!VALID_REPORTS.includes(type)) {
            return sendErrorResponse(
                res,
                400,
                `Invalid report type. Supported types: ${VALID_REPORTS.join(", ")}`
            );
        }

        const page = Math.max(parseInt(query.page, 10) || 1, 1);
        const limit = Math.min(
            Math.max(parseInt(query.limit, 10) || 10, 1),
            100
        );

        let sql = "";
        let values = [];

        // --------------------------------------------------
        // 1. CURRENT HOSTELLERS
        // --------------------------------------------------
        if (type === "current-hostellers") {
            const filter = buildFilters(query, {
                dateColumn: "h.join_date",
                buildingColumn: "r.building_id",
                searchColumns: [
                    "h.full_name",
                    "h.phone_number",
                    "h.aadhar_number",
                    "b.building_name",
                    "r.room_number",
                    "r.floor"
                ]
            });

            sql = `
                SELECT
                    h.full_name AS name,
                    h.phone_number AS phone,

                    CONCAT(
                        b.building_name,
                        ' – Floor ',
                        r.floor,
                        ' – Room ',
                        r.room_number
                    ) AS room,

                    CONCAT(r.sharing_type, ' Share') AS sharing,
                    h.fee_plan AS fee_plan,

                    TO_CHAR(h.join_date, 'YYYY-MM-DD') AS joined,

                    GREATEST(
                        CURRENT_DATE - h.join_date,
                        0
                    )::INTEGER AS days_stayed

                FROM tbl_hostellers h

                JOIN tbl_room_allocations a
                    ON a.hosteller_id = h.hosteller_id
                    AND a.status = 'ACTIVE'

                JOIN tbl_rooms r
                    ON r.room_id = a.room_id

                JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                WHERE h.status = 'Staying'
                ${filter.where}

                ORDER BY h.hosteller_id DESC
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 2. VACATED HOSTELLERS
        // --------------------------------------------------
        else if (type === "vacated-hostellers") {
            const filter = buildFilters(query, {
                dateColumn: "h.vacating_date",
                buildingColumn: "r.building_id",
                searchColumns: [
                    "h.full_name",
                    "h.phone_number",
                    "h.aadhar_number",
                    "b.building_name",
                    "r.room_number",
                    "h.vacating_reason"
                ]
            });

            sql = `
                SELECT
                    h.full_name AS name,
                    h.phone_number AS phone,

                    CONCAT(
                        b.building_name,
                        ' – Floor ',
                        r.floor,
                        ' – Room ',
                        r.room_number
                    ) AS room,

                    TO_CHAR(h.join_date, 'YYYY-MM-DD') AS joined,

                    TO_CHAR(
                        COALESCE(h.vacating_date, a.vacated_date),
                        'YYYY-MM-DD'
                    ) AS vacated,

                    GREATEST(
                        COALESCE(h.vacating_date, a.vacated_date)::DATE
                        - h.join_date,
                        0
                    )::INTEGER AS days_stayed,

                    COALESCE(
                        h.vacating_reason,
                        h.vacating_remarks,
                        '-'
                    ) AS reason

                FROM tbl_hostellers h

                LEFT JOIN LATERAL (
                    SELECT
                        allocation_id,
                        room_id,
                        vacated_date
                    FROM tbl_room_allocations
                    WHERE hosteller_id = h.hosteller_id
                    ORDER BY allocation_id DESC
                    LIMIT 1
                ) a ON TRUE

                LEFT JOIN tbl_rooms r
                    ON r.room_id = a.room_id

                LEFT JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                WHERE h.status = 'Vacated'
                ${filter.where}

                ORDER BY h.vacating_date DESC NULLS LAST
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 3. FEE PAYMENTS
        // --------------------------------------------------
        else if (type === "fee-payments") {
            const filter = buildFilters(query, {
                dateColumn: "p.payment_date",
                buildingColumn: "r.building_id",
                searchColumns: [
                    "h.full_name",
                    "h.phone_number",
                    "b.building_name",
                    "f.fee_type",
                    "p.payment_mode",
                    "p.reference_note"
                ]
            });

            let extraConditions = "";

            if (query.feeType) {
                values.push(query.feeType);
                extraConditions += ` AND f.fee_type = $${filter.values.length + values.length}`;
            }

            if (query.paymentMode) {
                values.push(query.paymentMode);
                extraConditions += ` AND p.payment_mode = $${filter.values.length + values.length}`;
            }

            const allValues = [...filter.values, ...values];

            sql = `
                SELECT
                    COALESCE(
                        NULLIF(to_jsonb(p)->>'receipt_number', ''),
                        NULLIF(to_jsonb(p)->>'receipt_no', ''),
                        'RC' || LPAD(p.payment_id::TEXT, 6, '0')
                    ) AS receipt,

                    TO_CHAR(p.payment_date, 'YYYY-MM-DD') AS paid_on,

                    h.full_name AS hosteller,

                    b.building_name AS building,

                    CASE
                        WHEN LOWER(f.fee_type) LIKE '%day%'
                            THEN CONCAT(
                                f.fee_type,
                                ' × ',
                                COALESCE(
                                    NULLIF(to_jsonb(f)->>'number_of_days', ''),
                                    NULLIF(to_jsonb(f)->>'number_of_months', ''),
                                    '1'
                                ),
                                CASE
                                    WHEN NULLIF(to_jsonb(f)->>'number_of_days', '') IS NOT NULL
                                        THEN ' day(s)'
                                    ELSE ' month(s)'
                                END
                            )
                        ELSE f.fee_type
                    END AS fee_type,

                    CONCAT(
                        TO_CHAR(f.fee_period_start, 'YYYY-MM-DD'),
                        ' → ',
                        TO_CHAR(f.fee_period_end, 'YYYY-MM-DD')
                    ) AS period,

                    p.payment_mode AS mode,

                    COALESCE(p.reference_note, '-') AS note,

                    p.amount_paid AS amount

                FROM tbl_fee_payments p

                JOIN tbl_hostel_fees f
                    ON f.fee_id = p.fee_id

                JOIN tbl_hostellers h
                    ON h.hosteller_id = f.hosteller_id

                LEFT JOIN LATERAL (
                    SELECT room_id
                    FROM tbl_room_allocations
                    WHERE hosteller_id = h.hosteller_id
                    ORDER BY allocation_id DESC
                    LIMIT 1
                ) a ON TRUE

                LEFT JOIN tbl_rooms r
                    ON r.room_id = a.room_id

                LEFT JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                WHERE 1 = 1
                ${filter.where}
                ${extraConditions}

                ORDER BY p.payment_date DESC, p.payment_id DESC
            `;

            values = allValues;
        }

        // --------------------------------------------------
        // 4. MONTHLY COLLECTION
        // --------------------------------------------------
        else if (type === "monthly-collection") {
            const filter = buildFilters(query, {
                dateColumn: "p.payment_date",
                searchColumns: [
                    "h.full_name",
                    "h.phone_number",
                    "p.payment_mode"
                ]
            });

            sql = `
                SELECT
                    TO_CHAR(
                        DATE_TRUNC('month', p.payment_date),
                        'Mon YYYY'
                    ) AS fee_month,

                    COUNT(p.payment_id)::INTEGER AS payments,

                    COALESCE(
                        SUM(p.amount_paid),
                        0
                    ) AS collected

                FROM tbl_fee_payments p

                JOIN tbl_hostel_fees f
                    ON f.fee_id = p.fee_id

                JOIN tbl_hostellers h
                    ON h.hosteller_id = f.hosteller_id

                WHERE 1 = 1
                ${filter.where}

                GROUP BY DATE_TRUNC('month', p.payment_date)

                ORDER BY DATE_TRUNC('month', p.payment_date) DESC
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 5. PENDING DUES
        // --------------------------------------------------
        else if (type === "pending-dues") {
            const filter = buildFilters(query, {
                dateColumn: "f.fee_period_start",
                buildingColumn: "r.building_id",
                searchColumns: [
                    "h.full_name",
                    "h.phone_number",
                    "b.building_name",
                    "r.room_number",
                    "f.fee_type"
                ]
            });

            sql = `
                SELECT
                    h.full_name AS hosteller,
                    h.phone_number AS phone,

                    CONCAT(
                        b.building_name,
                        ' – Floor ',
                        r.floor,
                        ' – Room ',
                        r.room_number
                    ) AS room,

                    h.fee_plan AS fee_plan,

                    TO_CHAR(
                        f.fee_period_start,
                        'Mon YYYY'
                    ) AS due_for,

                    COALESCE(
                        paid.total_paid,
                        0
                    ) AS paid,

                    GREATEST(
                        f.fee_amount - COALESCE(paid.total_paid, 0),
                        0
                    ) AS balance

                FROM tbl_hostel_fees f

                JOIN tbl_hostellers h
                    ON h.hosteller_id = f.hosteller_id

                LEFT JOIN LATERAL (
                    SELECT
                        room_id
                    FROM tbl_room_allocations
                    WHERE hosteller_id = h.hosteller_id
                    ORDER BY allocation_id DESC
                    LIMIT 1
                ) a ON TRUE

                LEFT JOIN tbl_rooms r
                    ON r.room_id = a.room_id

                LEFT JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                LEFT JOIN (
                    SELECT
                        fee_id,
                        SUM(amount_paid) AS total_paid
                    FROM tbl_fee_payments
                    GROUP BY fee_id
                ) paid
                    ON paid.fee_id = f.fee_id

                WHERE h.status = 'Staying'
                    AND f.fee_amount > COALESCE(paid.total_paid, 0)

                ${filter.where}

                ORDER BY f.fee_period_start DESC, h.full_name
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 6. ROOM-WISE
        // --------------------------------------------------
        else if (type === "room-wise") {
            const filter = buildFilters(query, {
                buildingColumn: "r.building_id",
                searchColumns: [
                    "b.building_name",
                    "r.floor",
                    "r.room_number",
                    "h.full_name"
                ]
            });

            sql = `
                SELECT
                    b.building_name AS building,
                    r.floor AS floor,
                    r.room_number AS room,

                    CONCAT(r.sharing_type, ' Share') AS sharing,

                    r.monthly_cost AS cost_per_month,

                    COALESCE(
                        STRING_AGG(
                            h.full_name,
                            ', ' ORDER BY h.full_name
                        ),
                        '-'
                    ) AS staying_hostellers

                FROM tbl_rooms r

                JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                LEFT JOIN tbl_room_allocations a
                    ON a.room_id = r.room_id
                    AND a.status = 'ACTIVE'

                LEFT JOIN tbl_hostellers h
                    ON h.hosteller_id = a.hosteller_id
                    AND h.status = 'Staying'

                WHERE 1 = 1
                ${filter.where}

                GROUP BY
                    r.room_id,
                    b.building_name,
                    r.floor,
                    r.room_number,
                    r.sharing_type,
                    r.monthly_cost

                ORDER BY b.building_name, r.floor, r.room_number
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 7. VACANT BEDS
        // --------------------------------------------------
        else if (type === "vacant-beds") {
            const filter = buildFilters(query, {
                buildingColumn: "r.building_id",
                searchColumns: [
                    "b.building_name",
                    "r.floor",
                    "r.room_number"
                ]
            });

            sql = `
                SELECT
                    b.building_name AS building,
                    r.floor AS floor,
                    r.room_number AS room,

                    CONCAT(r.sharing_type, ' Share') AS sharing,

                    GREATEST(
                        r.sharing_type - COUNT(a.allocation_id)::INTEGER,
                        0
                    ) AS free_beds,

                    r.monthly_cost AS cost_per_month

                FROM tbl_rooms r

                JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                LEFT JOIN tbl_room_allocations a
                    ON a.room_id = r.room_id
                    AND a.status = 'ACTIVE'

                WHERE 1 = 1
                ${filter.where}

                GROUP BY
                    r.room_id,
                    b.building_name,
                    r.floor,
                    r.room_number,
                    r.sharing_type,
                    r.monthly_cost

                HAVING
                    r.sharing_type - COUNT(a.allocation_id)::INTEGER > 0

                ORDER BY b.building_name, r.floor, r.room_number
            `;

            values = filter.values;
        }

        // --------------------------------------------------
        // 8. BUILDING-WISE
        // --------------------------------------------------
        else if (type === "building-wise") {
            const filter = buildFilters(query, {
                searchColumns: [
                    "b.building_name"
                ]
            });

            sql = `
                WITH room_summary AS (
                    SELECT
                        r.room_id,
                        r.building_id,
                        r.sharing_type,
                        r.monthly_cost,

                        COUNT(a.allocation_id)::INTEGER AS occupied_beds,

                        GREATEST(
                            r.sharing_type - COUNT(a.allocation_id)::INTEGER,
                            0
                        ) AS vacant_beds

                    FROM tbl_rooms r

                    LEFT JOIN tbl_room_allocations a
                        ON a.room_id = r.room_id
                        AND a.status = 'ACTIVE'

                    GROUP BY
                        r.room_id,
                        r.building_id,
                        r.sharing_type,
                        r.monthly_cost
                )

                SELECT
                    b.building_name AS building,

                    COUNT(rs.room_id)::INTEGER AS rooms,

                    COALESCE(
                        SUM(rs.sharing_type),
                        0
                    )::INTEGER AS total_beds,

                    COALESCE(
                        SUM(rs.occupied_beds),
                        0
                    )::INTEGER AS hostellers,

                    COALESCE(
                        SUM(rs.vacant_beds),
                        0
                    )::INTEGER AS vacant_beds,

                    CASE
                        WHEN COALESCE(SUM(rs.sharing_type), 0) = 0
                            THEN '0%'
                        ELSE
                            ROUND(
                                SUM(rs.occupied_beds)::NUMERIC
                                / SUM(rs.sharing_type) * 100
                            )::TEXT || '%'
                    END AS occupancy,

                    COALESCE(
                        SUM(rs.monthly_cost),
                        0
                    ) AS monthly_rent

                FROM tbl_buildings b

                LEFT JOIN room_summary rs
                    ON rs.building_id = b.building_id

                WHERE 1 = 1
                ${filter.where}

                GROUP BY b.building_id, b.building_name

                ORDER BY b.building_name
            `;

            values = filter.values;
        }

        // Execute report query
        const result = await pool.query(sql, values);
        const allRecords = result.rows;

        // Totals before pagination
        const totals = calculateTotals(type, allRecords);

        // CSV export - exports all filtered records
        if (String(query.export).toLowerCase() === "csv") {
            const csv = createCsv(allRecords);

            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${type}.csv"`
            );

            return res.status(200).send(csv);
        }

        // Pagination
        const totalRecords = allRecords.length;
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;

        const records = allRecords.slice(
            offset,
            offset + limit
        );

        // Dropdown options
        const filterOptions = await getFilterOptions();

        return sendSuccessResponse(
            res,
            200,
            `${REPORT_TITLES[type]} fetched successfully`,
            {
                type,
                title: REPORT_TITLES[type],
                records,
                totals,
                filters: {
                    applied: {
                        search: query.search || null,
                        searchBy: query.searchBy || null,
                        month: query.month || null,
                        year: query.year || null,
                        startDate: query.startDate || null,
                        endDate: query.endDate || null,
                        building_id: query.building_id || null,
                        feeType: query.feeType || null,
                        paymentMode: query.paymentMode || null
                    },
                    options: filterOptions
                },
                pagination: {
                    page,
                    limit,
                    totalRecords,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        );

    } catch (error) {
        console.error("Get reports error:", error);

        return sendErrorResponse(
            res,
            500,
            "Failed to fetch reports"
        );
    }
}
