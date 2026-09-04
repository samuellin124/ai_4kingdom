<?php
/**
 * Plugin Name: AI4Kingdom Membership
 * Description: 提供 headless 前端使用的 session + PMS 會員方案端點，取代 hello-biz 主題內的 auth.php。
 * Version:     1.2.0
 *
 * 為什麼是 mu-plugin：原本這些路由寫在 themes/hello-biz/includes/auth.php，
 * 主題更新會整個資料夾覆蓋，端點就會消失。mu-plugin 不受主題／外掛更新影響。
 *
 * 提供：
 * - GET  /wp-json/hello-biz/v1/session          （cookie 判定目前使用者）
 * - GET  /wp-json/custom/v1/validate_session    （同上，相容舊路徑）
 * - POST /wp-json/custom/v1/validate_session    （伺服器對伺服器，需 service token）
 *
 * 三者都回傳 subscription 物件，這是主題版本缺少的部分。
 *
 * @package AI4Kingdom
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * PMS 方案 ID → 前端方案代號。
 * 對照 wp_posts 內 post_type = 'pms-subscription' 的項目。
 */
function a4k_plan_map() {
	return apply_filters(
		'a4k_plan_map',
		array(
			18   => 'free',     // 免费会员
			3580 => 'pro',      // 普通会员
			3582 => 'pro',      // 普通会员 Annual
			3583 => 'ultimate', // 高级会员
			3584 => 'ultimate', // 高级会员 Annual
		)
	);
}

/** 方案代號的高低排序，用來在多筆訂閱中取最高者。 */
function a4k_plan_rank( $type ) {
	$rank = array(
		'free'     => 0,
		'pro'      => 1,
		'ultimate' => 2,
	);
	return isset( $rank[ $type ] ) ? $rank[ $type ] : -1;
}

/** 從 PMS 的 array/object 混用結構安全取值。 */
function a4k_field( $row, $key ) {
	if ( is_array( $row ) ) {
		return isset( $row[ $key ] ) ? $row[ $key ] : null;
	}
	if ( is_object( $row ) && isset( $row->$key ) ) {
		return $row->$key;
	}
	return null;
}

/**
 * 判斷一筆 PMS 訂閱是否仍在有效期內。
 * active 直接算數；canceled 但尚未到期的仍應保有權益（PMS 的正常行為）。
 */
function a4k_subscription_is_live( $status, $expiration ) {
	if ( 'active' === $status ) {
		return true;
	}
	if ( 'canceled' === $status && $expiration && '0000-00-00 00:00:00' !== $expiration ) {
		return strtotime( $expiration ) > time();
	}
	return false;
}

/**
 * 取得指定使用者的訂閱狀態。
 * 查不到任何有效訂閱時回傳 free（與前端既有的預設一致）。
 *
 * @param int $user_id 使用者 ID。
 * @return array
 */
function a4k_get_subscription( $user_id ) {
	$default = array(
		'status'  => 'active',
		'type'    => 'free',
		'expiry'  => null,
		'plan_id' => null,
		'roles'   => array( 'free_member' ),
	);

	$user_id = (int) $user_id;
	if ( $user_id <= 0 || ! function_exists( 'pms_get_member_subscriptions' ) ) {
		return $default;
	}

	$subscriptions = pms_get_member_subscriptions( array( 'user_id' => $user_id ) );
	if ( empty( $subscriptions ) || ! is_array( $subscriptions ) ) {
		return $default;
	}

	$map   = a4k_plan_map();
	$best  = null;

	foreach ( $subscriptions as $row ) {
		$status     = (string) a4k_field( $row, 'status' );
		$expiration = (string) a4k_field( $row, 'expiration_date' );
		$plan_id    = (int) a4k_field( $row, 'subscription_plan_id' );

		if ( ! a4k_subscription_is_live( $status, $expiration ) ) {
			continue;
		}
		if ( ! isset( $map[ $plan_id ] ) ) {
			continue;
		}

		$type = $map[ $plan_id ];
		if ( null === $best || a4k_plan_rank( $type ) > a4k_plan_rank( $best['type'] ) ) {
			$best = array(
				'status'  => 'active',
				'type'    => $type,
				'expiry'  => ( $expiration && '0000-00-00 00:00:00' !== $expiration ) ? $expiration : null,
				'plan_id' => (string) $plan_id,
				'roles'   => array( $type . '_member' ),
			);
		}
	}

	return $best ? $best : $default;
}

/** 組出前端要的 payload。 */
function a4k_session_payload( $user ) {
	$logged = ( $user && $user->ID );

	return array(
		'logged_in'    => (bool) $logged,
		'user'         => $logged ? array(
			'id'    => (int) $user->ID,
			'name'  => (string) $user->display_name,
			'email' => (string) $user->user_email,
		) : null,
		'subscription' => $logged ? a4k_get_subscription( $user->ID ) : null,
		'nonce'        => wp_create_nonce( 'wp_rest' ),
	);
}

/** 加上不可快取標頭後回傳。 */
function a4k_session_response( $payload ) {
	$response = new WP_REST_Response( $payload, 200 );
	$response->header( 'Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0' );
	$response->header( 'Pragma', 'no-cache' );
	return $response;
}

/** 這個請求是否帶了合法的 service token。 */
function a4k_is_service_request( WP_REST_Request $request ) {
	if ( ! defined( 'A4K_SERVICE_TOKEN' ) || ! A4K_SERVICE_TOKEN ) {
		return false;
	}
	$sent = (string) $request->get_header( 'x_a4k_service_token' );
	if ( '' === $sent ) {
		return false;
	}
	return hash_equals( (string) A4K_SERVICE_TOKEN, $sent );
}

/** 兩個路由共用的處理器，註冊與濾鏡都指向它們。 */
function a4k_session_handler() {
	// cookie 判定目前使用者。REST 有時不會自動套用前端帶來的登入 cookie，故補一段還原。
	if ( ! is_user_logged_in() ) {
		$validated_user_id = wp_validate_auth_cookie( '', 'logged_in' );
		if ( $validated_user_id ) {
			wp_set_current_user( (int) $validated_user_id );
		}
	}
	return a4k_session_response( a4k_session_payload( wp_get_current_user() ) );
}

/**
 * 伺服器對伺服器：用 userId 查任意使用者的方案。
 * 沒有 service token 就退回 cookie 判定，絕不讓未授權者用 userId 列舉會員資料。
 */
function a4k_lookup_handler( WP_REST_Request $request ) {
	$user_id = (int) $request->get_param( 'userId' );

	if ( $user_id <= 0 ) {
		return a4k_session_handler();
	}

	if ( ! a4k_is_service_request( $request ) ) {
		return new WP_Error(
			'a4k_forbidden',
			__( 'A valid service token is required to look up another user.', 'ai4kingdom' ),
			array( 'status' => 403 )
		);
	}

	$user = get_user_by( 'id', $user_id );
	if ( ! $user ) {
		return new WP_Error(
			'a4k_no_user',
			__( 'User not found.', 'ai4kingdom' ),
			array( 'status' => 404 )
		);
	}

	return a4k_session_response( a4k_session_payload( $user ) );
}

/** 讓路由存在於各自的 namespace 索引中。 */
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'hello-biz/v1',
			'/session',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => 'a4k_session_handler',
			)
		);

		register_rest_route(
			'custom/v1',
			'/validate_session',
			array(
				array(
					'methods'             => 'GET',
					'permission_callback' => '__return_true',
					'callback'            => 'a4k_lookup_handler',
				),
				array(
					'methods'             => 'POST',
					'permission_callback' => '__return_true',
					'callback'            => 'a4k_lookup_handler',
				),
			)
		);
	},
	20
);

/**
 * 移除 hello-biz 主題註冊的同名路由 handler，只留下本外掛的。
 *
 * 主題 includes/auth.php 也註冊了這兩條路由，且 register_rest_route() 的 $override
 * 參數在這裡不足以取代它 —— 實測結果仍是 GET, GET, POST 三個 handler，主題那個
 * GET 排在前面而勝出。
 *
 * 這裡刻意只 unset 掉別人的 handler，而不是重建整個陣列：該陣列除了數字索引的
 * handler 之外，還帶著 WP 自己放進去的 'namespace' 等 meta 鍵，整份重建會把它們
 * 弄丟，導致路由直接 404。
 */
add_filter(
	'rest_endpoints',
	function ( $endpoints ) {
		$routes = array( '/hello-biz/v1/session', '/custom/v1/validate_session' );

		foreach ( $routes as $route ) {
			if ( empty( $endpoints[ $route ] ) || ! is_array( $endpoints[ $route ] ) ) {
				continue;
			}

			$mine = array();
			foreach ( $endpoints[ $route ] as $key => $handler ) {
				if ( ! is_numeric( $key ) ) {
					continue; // 'namespace' 等 meta，保留不動
				}
				$callback = isset( $handler['callback'] ) ? $handler['callback'] : null;
				if ( is_string( $callback ) && 0 === strpos( $callback, 'a4k_' ) ) {
					$mine[] = $key;
				}
			}

			// 只有在確定自己的 handler 有註冊成功時才動手，避免把路由清成空的。
			if ( empty( $mine ) ) {
				continue;
			}

			foreach ( $endpoints[ $route ] as $key => $handler ) {
				if ( is_numeric( $key ) && ! in_array( $key, $mine, true ) ) {
					unset( $endpoints[ $route ][ $key ] );
				}
			}
		}

		return $endpoints;
	},
	99
);
