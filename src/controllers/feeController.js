import pool from "../config/database.js";
import {
    sendSuccessResponse,
    sendErrorResponse
} from "../utils/response.js";

const PAYMENT_MODES = [
    "Cash",
    "UPI",
    "Bank Transfer",
    "Card",
    "Other"
];

function addMonths(dateString, months) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    // Clamp to the final day of the target month.
    const targetMonth = date.getUTCMonth() + months;
    const lastDay = new Date(
        Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0)
    ).getUTCDate();

    date.setUTCDate(Math.min(day, lastDay));
    date.setUTCMonth(targetMonth);

    return date.toISOString().slice(0, 10);
}

function getPeriodEnd(fromDate, months) {
    const nextPeriod = addMonths(fromDate, months);
    const [year, month, day] = nextPeriod.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}

export async function collectFee(req, res) {
    const {
        hosteller_id,
        fee_type,
        number_of_months,
        from_date,
        amount,
        amount_paid,
        payment_date,
        payment_mode,
        reference_note
    } = req.body;

    if (!Number.isInteger(Number(hosteller_id)) || Number(hosteller_id) <= 0) {
        return sendErrorResponse(res, 400, "Valid hosteller_id is required");
    }

    if (!["Monthly", "Weekly", "Day-wise"].includes(fee_type)) {
        return sendErrorResponse(res, 400, "Invalid fee_type");
    }

    if (!from_date || !payment_date) {
        return sendErrorResponse(
            res, 400, "from_date and payment_date are required"
        );
    }

    if (!PAYMENT_MODES.includes(payment_mode)) {
        return sendErrorResponse(res, 400, "Invalid payment_mode");
    }

    if (fee_type === "Monthly" &&
        (!Number.isInteger(Number(number_of_months)) ||
         Number(number_of_months) < 1 ||
         Number(number_of_months) > 120)) {
        return sendErrorResponse(
            res, 400, "number_of_months must be between 1 and 120"
        );
    }

    if (fee_type !== "Monthly" && number_of_months != null) {
        return sendErrorResponse(
            res, 400, "number_of_months is only applicable to Monthly fees"
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const hostellerResult = await client.query(
            `SELECT
                h.hosteller_id,
                h.status AS hosteller_status,
                r.monthly_cost
             FROM tbl_hostellers h
             LEFT JOIN tbl_room_allocations a
                ON a.hosteller_id = h.hosteller_id
                AND a.status = 'ACTIVE'
             LEFT JOIN tbl_rooms r
                ON r.room_id = a.room_id
             WHERE h.hosteller_id = $1
             FOR UPDATE OF h`,
            [hosteller_id]
        );

        if (!hostellerResult.rowCount) {
            await client.query("ROLLBACK");
            return sendErrorResponse(res, 404, "Hosteller not found");
        }

        const hosteller = hostellerResult.rows[0];

        if (hosteller.hosteller_status !== "Staying") {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res, 409, "Fees cannot be collected for a vacated hosteller"
            );
        }

        if (hosteller.monthly_cost == null) {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res, 400, "Hosteller does not have an active room with a monthly cost"
            );
        }

        const months = fee_type === "Monthly"
            ? Number(number_of_months)
            : null;

        // Amount is editable by the admin.
        const feeAmount = amount == null
            ? Number(hosteller.monthly_cost) *
                (fee_type === "Monthly" ? months : 1)
            : Number(amount);

        const paidAmount = amount_paid == null
            ? feeAmount
            : Number(amount_paid);

        if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
            await client.query("ROLLBACK");
            return sendErrorResponse(res, 400, "amount must be greater than zero");
        }

        if (!Number.isFinite(paidAmount) ||
            paidAmount <= 0 ||
            paidAmount > feeAmount) {
            await client.query("ROLLBACK");
            return sendErrorResponse(
                res, 400, "amount_paid must be positive and cannot exceed amount"
            );
        }

        const periodEnd = fee_type === "Monthly"
            ? getPeriodEnd(from_date, months)
            : from_date;

        const feeResult = await client.query(
            `INSERT INTO tbl_hostel_fees (
                hosteller_id,
                fee_type,
                number_of_months,
                fee_period_start,
                fee_period_end,
                fee_amount
             )
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
                hosteller_id,
                fee_type,
                months,
                from_date,
                periodEnd,
                feeAmount
            ]
        );

        const fee = feeResult.rows[0];

        const paymentResult = await client.query(
            `INSERT INTO tbl_fee_payments (
                fee_id,
                amount_paid,
                payment_date,
                payment_mode,
                reference_note
             )
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [
                fee.fee_id,
                paidAmount,
                payment_date,
                payment_mode,
                reference_note?.trim() || null
            ]
        );

        const payment = paymentResult.rows[0];
        const balance = Number(
            (feeAmount - paidAmount).toFixed(2)
        );

        const feeStatus = balance === 0
            ? "PAID"
            : "PARTIAL";

        await client.query(
            `UPDATE tbl_hostel_fees
             SET updated_at = CURRENT_TIMESTAMP
             WHERE fee_id = $1`,
            [fee.fee_id]
        );

        await client.query("COMMIT");

        return sendSuccessResponse(res, 201, "Fee collected successfully", {
            fee,
            payment,
            total_amount: feeAmount,
            amount_paid: paidAmount,
            balance,
            status: feeStatus
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Collect fee error:", error);

        return sendErrorResponse(res, 500, "Failed to collect fee");
    } finally {
        client.release();
    }
}


export async function getFeeSummary(req, res) {
    try {
        const month =
            req.query.month || new Date().toISOString().slice(0, 7);

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Invalid month. Use YYYY-MM format."
            });
        }

        const query = `
            WITH selected_month AS (
                SELECT
                    $1::date AS month_start,
                    ($1::date + INTERVAL '1 month')::date AS next_month
            ),
            hosteller_fees AS (
                SELECT
                    h.hosteller_id,
                    h.full_name,
                    h.phone_number,
                    h.status AS hosteller_status,

                    CASE
                        WHEN b.building_name IS NULL THEN NULL
                        ELSE CONCAT(
                            b.building_name,
                            ' – Floor ',
                            CASE
                                WHEN r.floor::text = '1' THEN '1st'
                                WHEN r.floor::text = '2' THEN '2nd'
                                WHEN r.floor::text = '3' THEN '3rd'
                                ELSE r.floor::text 
                            END,
                            ' – Room ',
                            r.room_number
                        )
                    END AS room,

                    r.sharing_type AS sharing,

                    COALESCE(f.fee_plan, 'Monthly') AS fee_plan,
                    COALESCE(f.fee_amount, 0) AS rate,
                    COALESCE(p.paid_amount, 0) AS paid

                FROM tbl_hostellers h

                LEFT JOIN LATERAL (
                    SELECT a.room_id
                    FROM tbl_room_allocations a
                    WHERE a.hosteller_id = h.hosteller_id
                      AND a.status = 'ACTIVE'
                    ORDER BY
                        a.allocation_date DESC,
                        a.allocation_id DESC
                    LIMIT 1
                ) allocation ON TRUE

                LEFT JOIN tbl_rooms r
                    ON r.room_id = allocation.room_id

                LEFT JOIN tbl_buildings b
                    ON b.building_id = r.building_id

                CROSS JOIN selected_month sm

                LEFT JOIN LATERAL (
                    SELECT
                        hf.fee_type AS fee_plan,
                        SUM(hf.fee_amount) AS fee_amount
                    FROM tbl_hostel_fees hf
                    WHERE hf.hosteller_id = h.hosteller_id
                      AND hf.fee_period_start < sm.next_month
                      AND hf.fee_period_end >= sm.month_start
                    GROUP BY hf.fee_type
                    ORDER BY hf.fee_type
                    LIMIT 1
                ) f ON TRUE

                LEFT JOIN LATERAL (
                    SELECT SUM(fp.amount_paid) AS paid_amount
                    FROM tbl_fee_payments fp
                    JOIN tbl_hostel_fees hf
                        ON hf.fee_id = fp.fee_id
                    WHERE hf.hosteller_id = h.hosteller_id
                      AND fp.payment_date >= sm.month_start
                      AND fp.payment_date < sm.next_month
                ) p ON TRUE

                WHERE h.status = 'Staying'
            )
            SELECT
                COALESCE(SUM(rate), 0) AS "monthlyPlanTotal",

                COALESCE(SUM(paid), 0) AS collected,

                GREATEST(
                    COALESCE(SUM(rate), 0)
                    - COALESCE(SUM(paid), 0),
                    0
                ) AS pending,

                COUNT(*) FILTER (
                    WHERE rate > 0 AND paid >= rate
                ) AS "fullyPaid",

                COUNT(*) AS "totalHostellers",

                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'hosteller_id', hosteller_id,
                            'hosteller', full_name,
                            'phone', phone_number,
                            'room', room,
                            'sharing', sharing,
                            'fee_plan', fee_plan,
                            'rate', rate,
                            'paid', paid,
                            'balance', GREATEST(rate - paid, 0),
                            'status',
                                CASE
                                    WHEN rate <= 0 THEN 'Pending'
                                    WHEN paid >= rate THEN 'Paid'
                                    WHEN paid > 0 THEN 'Partial'
                                    ELSE 'Pending'
                                END,
                            'action', hosteller_id
                        )
                        ORDER BY full_name
                    ),
                    '[]'::json
                ) AS hostellers

            FROM hosteller_fees;
        `;

        const result = await pool.query(query, [`${month}-01`]);
        const row = result.rows[0];

        return res.status(200).json({
            success: true,
            data: {
                month,
                summary: {
                    monthlyPlanTotal: Number(row.monthlyPlanTotal),
                    collected: Number(row.collected),
                    pending: Number(row.pending),
                    fullyPaid: Number(row.fullyPaid),
                    totalHostellers: Number(row.totalHostellers)
                },
                hostellers: row.hostellers
            },
            message: "Fee summary fetched successfully"
        });
    } catch (error) {
        console.error("Get fee summary error:", error);

        return res.status(500).json({
            success: false,
            data: null,
            message: "Failed to fetch fee summary"
        });
    }
}


export async function getPaymentHistory(req, res) {
    try {
        const month =
            req.query.month || new Date().toISOString().slice(0, 7);

        const search = (req.query.search || "").trim();
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 20, 1),
            100
        );
        const offset = (page - 1) * limit;

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Invalid month. Use YYYY-MM format."
            });
        }

        const query = `
            WITH payment_history AS (
                SELECT
                    'RC' || LPAD(fp.payment_id::text, 4, '0')
                        AS payment_id,

                    fp.payment_date AS paid_on,
                    h.full_name AS hosteller,

                    CASE
                        WHEN hf.fee_type = 'Day-wise'
                            THEN 'Day-wise × ' ||
                                ((hf.fee_period_end - hf.fee_period_start) + 1)::text ||
                                ' day(s)'

                        WHEN hf.fee_type = 'Weekly'
                            THEN 'Weekly'

                        WHEN hf.fee_type = 'Monthly'
                            THEN 'Monthly'

                        ELSE hf.fee_type
                    END AS fee_type,

                    TO_CHAR(hf.fee_period_start, 'YYYY-MM-DD')
                        || ' → ' ||
                    TO_CHAR(hf.fee_period_end, 'YYYY-MM-DD')
                        AS period,

                    fp.amount_paid AS amount,
                    fp.payment_mode AS mode,
                    fp.reference_note AS note

                FROM tbl_fee_payments fp

                JOIN tbl_hostel_fees hf
                    ON hf.fee_id = fp.fee_id

                JOIN tbl_hostellers h
                    ON h.hosteller_id = hf.hosteller_id

                WHERE fp.payment_date >= $1::date
                  AND fp.payment_date < (
                      $1::date + INTERVAL '1 month'
                  )
                  AND (
                      $2 = ''
                      OR h.full_name ILIKE '%' || $2 || '%'
                      OR h.phone_number ILIKE '%' || $2 || '%'
                      OR fp.payment_mode ILIKE '%' || $2 || '%'
                      OR fp.reference_note ILIKE '%' || $2 || '%'
                      OR (
                          'RC' || LPAD(fp.payment_id::text, 4, '0')
                      ) ILIKE '%' || $2 || '%'
                  )
            )
            SELECT
                *,
                COUNT(*) OVER() AS total_records
            FROM payment_history
            ORDER BY paid_on DESC, payment_id DESC
            LIMIT $3 OFFSET $4;
        `;

        const result = await pool.query(query, [
            `${month}-01`,
            search,
            limit,
            offset
        ]);

        const totalRecords = result.rows.length
            ? Number(result.rows[0].total_records)
            : 0;

        const payments = result.rows.map((row) => ({
            payment_id: row.payment_id,
            paid_on: row.paid_on,
            hosteller: row.hosteller,
            fee_type: row.fee_type,
            period: row.period,
            amount: Number(row.amount),
            mode: row.mode,
            note: row.note
        }));

        return res.status(200).json({
            success: true,
            data: {
                payments,
                pagination: {
                    page,
                    limit,
                    totalRecords,
                    totalPages: Math.ceil(totalRecords / limit)
                }
            },
            message: "Payment history fetched successfully"
        });
    } catch (error) {
        console.error("Get payment history error:", error);

        return res.status(500).json({
            success: false,
            data: null,
            message: "Failed to fetch payment history"
        });
    }
}



