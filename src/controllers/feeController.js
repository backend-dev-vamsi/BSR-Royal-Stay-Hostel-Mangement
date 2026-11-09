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
        payment_date,
        payment_mode,
        reference_note
    } = req.body;

    // Validate hosteller ID
    if (!Number.isInteger(Number(hosteller_id)) || Number(hosteller_id) <= 0) {
        return sendErrorResponse(res, 400, "Valid hosteller_id is required");
    }

    // Validate fee type
    if (!["Monthly", "Weekly", "Day-wise"].includes(fee_type)) {
        return sendErrorResponse(res, 400, "Invalid fee_type");
    }

    // Validate dates
    if (!from_date || !payment_date) {
        return sendErrorResponse(
            res,
            400,
            "from_date and payment_date are required"
        );
    }

    // Validate payment mode
    if (!PAYMENT_MODES.includes(payment_mode)) {
        return sendErrorResponse(res, 400, "Invalid payment_mode");
    }

    // Validate number of months
    if (
        fee_type === "Monthly" &&
        (
            !Number.isInteger(Number(number_of_months)) ||
            Number(number_of_months) < 1 ||
            Number(number_of_months) > 120
        )
    ) {
        return sendErrorResponse(
            res,
            400,
            "number_of_months must be between 1 and 120"
        );
    }

    if (fee_type !== "Monthly" && number_of_months != null) {
        return sendErrorResponse(
            res,
            400,
            "number_of_months is only applicable to Monthly fees"
        );
    }

    // Validate amount
    const paidAmount = Number(amount);

    if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
        return sendErrorResponse(
            res,
            400,
            "amount must be greater than zero"
        );
    }

    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query("BEGIN");
        transactionStarted = true;

        // Lock hosteller row to prevent simultaneous payments
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
            transactionStarted = false;

            return sendErrorResponse(res, 404, "Hosteller not found");
        }

        const hosteller = hostellerResult.rows[0];

        if (hosteller.hosteller_status !== "Staying") {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return sendErrorResponse(
                res,
                409,
                "Fees cannot be collected for a vacated hosteller"
            );
        }

        if (hosteller.monthly_cost == null) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return sendErrorResponse(
                res,
                400,
                "Hosteller does not have an active room with a monthly cost"
            );
        }

        const monthlyCost = Number(hosteller.monthly_cost);

        const months = fee_type === "Monthly"
            ? Number(number_of_months)
            : null;

        // Calculate fee period
        const periodEnd = fee_type === "Monthly"
            ? getPeriodEnd(from_date, months)
            : from_date;

        let feeAmount;
        let balance;

        if (fee_type === "Monthly") {
            // Monthly fee = room monthly cost × number of months
            feeAmount = Number(
                (monthlyCost * months).toFixed(2)
            );

            // Get existing payments for the requested fee period
            const existingPaymentResult = await client.query(
                `SELECT
                    COALESCE(SUM(fp.amount_paid), 0) AS total_paid
                 FROM tbl_fee_payments fp
                 INNER JOIN tbl_hostel_fees hf
                    ON hf.fee_id = fp.fee_id
                 WHERE hf.hosteller_id = $1
                   AND hf.fee_type = 'Monthly'
                   AND hf.fee_period_start < ($3::date + INTERVAL '1 day')
                   AND hf.fee_period_end >= $2::date`,
                [hosteller_id, from_date, periodEnd]
            );

            const alreadyPaid = Number(
                existingPaymentResult.rows[0].total_paid
            );

            const remainingBalance = Math.max(
                Number((feeAmount - alreadyPaid).toFixed(2)),
                0
            );

            if (remainingBalance <= 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return sendErrorResponse(
                    res,
                    409,
                    "Hosteller has already paid for this month"
                );
            }

            if (paidAmount > remainingBalance) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return sendErrorResponse(
                    res,
                    400,
                    `Payment exceeds the remaining balance of ${remainingBalance}`
                );
            }

            balance = Number(
                (remainingBalance - paidAmount).toFixed(2)
            );

        } else {
            // Weekly and Day-wise fee calculation
            feeAmount = monthlyCost;

            const existingPaymentResult = await client.query(
                `SELECT
                    COALESCE(SUM(fp.amount_paid), 0) AS total_paid
                 FROM tbl_fee_payments fp
                 INNER JOIN tbl_hostel_fees hf
                    ON hf.fee_id = fp.fee_id
                 WHERE hf.hosteller_id = $1
                   AND hf.fee_type = $2
                   AND hf.fee_period_start = $3::date
                   AND hf.fee_period_end = $4::date`,
                [hosteller_id, fee_type, from_date, periodEnd]
            );

            const alreadyPaid = Number(
                existingPaymentResult.rows[0].total_paid
            );

            const remainingBalance = Math.max(
                Number((feeAmount - alreadyPaid).toFixed(2)),
                0
            );

            if (remainingBalance <= 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return sendErrorResponse(
                    res,
                    409,
                    "Hosteller has already paid for this fee period"
                );
            }

            if (paidAmount > remainingBalance) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return sendErrorResponse(
                    res,
                    400,
                    `Payment exceeds the remaining balance of ${remainingBalance}`
                );
            }

            balance = Number(
                (remainingBalance - paidAmount).toFixed(2)
            );
        }

        // Insert fee record
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

        // Insert payment record
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
        transactionStarted = false;

        return sendSuccessResponse(
            res,
            201,
            "Fee collected successfully",
            {
                fee,
                payment,
                total_amount: feeAmount,
                amount_paid: paidAmount,
                balance,
                status: feeStatus
            }
        );

    } catch (error) {
        if (transactionStarted) {
            await client.query("ROLLBACK");
        }

        console.error("Collect fee error:", error);

        return sendErrorResponse(
            res,
            500,
            "Failed to collect fee"
        );
    } finally {
        client.release();
    }
}


export async function getFeeSummary(req, res) {
    try {
        const month =
            req.query.month || new Date().toISOString().slice(0, 7);

        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            return sendErrorResponse(
                res,
                400,
                "Invalid month. Use YYYY-MM format."
            );
        }

        const query = `
            WITH selected_month AS (
                SELECT
                    $1::date AS month_start,
                    ($1::date + INTERVAL '1 month')::date AS next_month
            ),

            hosteller_details AS (
                SELECT
                    h.hosteller_id,
                    h.full_name,
                    h.phone_number,
                    h.fee_plan,

                    b.building_name,
                    r.floor,
                    r.room_number,
                    r.sharing_type,

                    COALESCE(r.monthly_cost, 0)::NUMERIC AS rate,

                    COALESCE(payment.total_paid, 0)::NUMERIC AS total_paid,

                    last_payment.payment_date

                FROM tbl_hostellers h

                LEFT JOIN LATERAL (
                    SELECT
                        a.room_id
                    FROM tbl_room_allocations a
                    WHERE a.hosteller_id = h.hosteller_id
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

                -- Total payments made during the selected month
                LEFT JOIN LATERAL (
                    SELECT
                        SUM(fp.amount_paid) AS total_paid
                    FROM tbl_fee_payments fp
                    INNER JOIN tbl_hostel_fees hf
                        ON hf.fee_id = fp.fee_id
                    WHERE hf.hosteller_id = h.hosteller_id
                      AND fp.payment_date >= sm.month_start
                      AND fp.payment_date < sm.next_month
                ) payment ON TRUE

                -- Latest payment date across all months
                LEFT JOIN LATERAL (
                    SELECT
                        MAX(fp.payment_date)::DATE AS payment_date
                    FROM tbl_fee_payments fp
                    INNER JOIN tbl_hostel_fees hf
                        ON hf.fee_id = fp.fee_id
                    WHERE hf.hosteller_id = h.hosteller_id
                ) last_payment ON TRUE

                WHERE h.status = 'Staying'
            ),

            calculated_fees AS (
                SELECT
                    *,
                    LEAST(total_paid, rate) AS paid,
                    GREATEST(
                        rate - LEAST(total_paid, rate),
                        0
                    ) AS balance
                FROM hosteller_details
            )

            SELECT
                COALESCE(SUM(rate), 0) AS monthly_plan_total,
                COALESCE(SUM(paid), 0) AS collected,
                COALESCE(SUM(balance), 0) AS pending,

                COUNT(*) FILTER (
                    WHERE rate > 0 AND balance = 0
                ) AS fully_paid,

                COUNT(*) AS total_hostellers,

                COALESCE(
                    JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'hosteller_id', hosteller_id,
                            'hosteller', full_name,
                            'phone', phone_number,
                            'building', building_name,
                            'floor', floor,
                            'room_no', room_number,
                            'sharing', sharing_type,
                            'fee_plan', fee_plan,
                            'rate', rate,
                            'paid', paid,
                            'balance', balance,

                            'status',
                                CASE
                                    WHEN balance = 0 AND rate > 0
                                        THEN 'Paid'
                                    WHEN paid > 0
                                        THEN 'Partial'
                                    ELSE 'Pending'
                                END,

                            'payment_date', payment_date
                        )
                        ORDER BY full_name
                    ),
                    '[]'::JSON
                ) AS hostellers

            FROM calculated_fees;
        `;

        const result = await pool.query(query, [`${month}-01`]);

        const row = result.rows[0];

        return sendSuccessResponse(
            res,
            200,
            "Fee summary fetched successfully",
            {
                month,
                summary: {
                    monthlyPlanTotal: Number(row.monthly_plan_total),
                    collected: Number(row.collected),
                    pending: Number(row.pending),
                    fullyPaid: Number(row.fully_paid),
                    totalHostellers: Number(row.total_hostellers)
                },
                hostellers: row.hostellers
            }
        );

    } catch (error) {
        console.error("Get fee summary error:", error);

        return sendErrorResponse(
            res,
            500,
            "Failed to fetch fee summary"
        );
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



