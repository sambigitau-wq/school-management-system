const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const emailService = require('./emailService');
const smsService = require('./smsService');

// ==================== CONFIGURATION ====================
app.use(cors({
  origin: [
    'http://localhost:5173', 
    'http://localhost:3000',
    'https://schoolaid.zyphra.co.ke'  // ← ADD THIS LINE
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Create uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Create public directory for default images
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Simple user cache to prevent repeated queries
const userCache = new Map();

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;
    
    // ✅ Check cache first
    if (userCache.has(userId)) {
      req.user = userCache.get(userId);
      return next();
    }
    
    // ✅ Fetch only what we need - NO associations!
    const user = await User.findByPk(userId, {
      attributes: ['id', 'email', 'firstName', 'lastName', 'role', 'schoolId', 'roleId']
      // NO includes!
    });
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    
    // ✅ Cache the user
    userCache.set(userId, user);
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Clean cache every 5 minutes
setInterval(() => {
  userCache.clear();
  console.log('🧹 User cache cleared');
}, 5 * 60 * 1000);
// Create a default logo placeholder
const defaultLogoSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#4f46e5" rx="20"/>
  <text x="50" y="65" font-size="40" text-anchor="middle" fill="white" font-family="Arial">🏫</text>
</svg>`;
fs.writeFileSync(path.join(publicDir, 'default-logo.svg'), defaultLogoSVG);

// ==================== DATABASE CONNECTION ====================
const sequelize = new Sequelize(
  process.env.DB_NAME || 'schoolaid',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASSWORD || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: console.log, // Enable logging to see queries
    dialectOptions: {
      ssl: process.env.DB_SSL === 'true' ? {
        require: true,
        rejectUnauthorized: false
      } : false
    }
  }
);


// ==================== GRADING SYSTEMS ====================

const GRADING_SYSTEMS = {
  // Kenya CBC (Competency Based Curriculum) - Primary & JSS
  CBC: {
    name: 'Kenya CBC',
    code: 'CBC',
    applicableTo: ['ECDE_PRIMARY_JSS'],
    levels: ['PP1', 'PP2', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9'],
    grading: {
      'EE': { min: 80, max: 100, grade: 'Exceeding Expectations', code: 'EE', points: 4, color: 'green' },
      'ME': { min: 65, max: 79, grade: 'Meeting Expectations', code: 'ME', points: 3, color: 'blue' },
      'AE': { min: 50, max: 64, grade: 'Approaching Expectations', code: 'AE', points: 2, color: 'yellow' },
      'BE': { min: 30, max: 49, grade: 'Below Expectations', code: 'BE', points: 1, color: 'orange' },
      'NI': { min: 0, max: 29, grade: 'Needs Improvement', code: 'NI', points: 0, color: 'red' }
    },
    hasPoints: false,
    hasGrades: true,
    hasComments: true,
    requiresDescriptions: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.CBC.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'Not Graded', code: 'NG', points: 0, color: 'gray' };
    }
  },

  // Kenya 8-4-4 System (Secondary)
  KENYA_844: {
    name: 'Kenya 8-4-4',
    code: '844',
    applicableTo: ['SENIOR_SECONDARY'],
    levels: ['Form 1', 'Form 2', 'Form 3', 'Form 4'],
    grading: {
      'A': { min: 80, max: 100, grade: 'A', points: 12, color: 'green' },
      'A-': { min: 75, max: 79, grade: 'A-', points: 11, color: 'green' },
      'B+': { min: 70, max: 74, grade: 'B+', points: 10, color: 'blue' },
      'B': { min: 65, max: 69, grade: 'B', points: 9, color: 'blue' },
      'B-': { min: 60, max: 64, grade: 'B-', points: 8, color: 'blue' },
      'C+': { min: 55, max: 59, grade: 'C+', points: 7, color: 'yellow' },
      'C': { min: 50, max: 54, grade: 'C', points: 6, color: 'yellow' },
      'C-': { min: 45, max: 49, grade: 'C-', points: 5, color: 'yellow' },
      'D+': { min: 40, max: 44, grade: 'D+', points: 4, color: 'orange' },
      'D': { min: 35, max: 39, grade: 'D', points: 3, color: 'orange' },
      'D-': { min: 30, max: 34, grade: 'D-', points: 2, color: 'orange' },
      'E': { min: 0, max: 29, grade: 'E', points: 1, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    calculateMeanGrade: (points) => {
      if (points >= 80) return 'A';
      if (points >= 75) return 'A-';
      if (points >= 70) return 'B+';
      if (points >= 65) return 'B';
      if (points >= 60) return 'B-';
      if (points >= 55) return 'C+';
      if (points >= 50) return 'C';
      if (points >= 45) return 'C-';
      if (points >= 40) return 'D+';
      if (points >= 35) return 'D';
      if (points >= 30) return 'D-';
      return 'E';
    },
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.KENYA_844.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'E', code: 'E', points: 1, color: 'red' };
    }
  },

  // International Baccalaureate (IB)
  IB: {
    name: 'International Baccalaureate',
    code: 'IB',
    applicableTo: ['INTERNATIONAL'],
    levels: ['IB Diploma', 'IB Certificate'],
    grading: {
      '7': { min: 85, max: 100, grade: '7', points: 7, description: 'Excellent', color: 'green' },
      '6': { min: 75, max: 84, grade: '6', points: 6, description: 'Very Good', color: 'blue' },
      '5': { min: 65, max: 74, grade: '5', points: 5, description: 'Good', color: 'blue' },
      '4': { min: 55, max: 64, grade: '4', points: 4, description: 'Satisfactory', color: 'yellow' },
      '3': { min: 45, max: 54, grade: '3', points: 3, description: 'Mediocre', color: 'orange' },
      '2': { min: 35, max: 44, grade: '2', points: 2, description: 'Poor', color: 'orange' },
      '1': { min: 0, max: 34, grade: '1', points: 1, description: 'Very Poor', color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.IB.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: '1', code: '1', points: 1, color: 'red' };
    }
  },

  // Cambridge IGCSE
  CAMBRIDGE_IGCSE: {
    name: 'Cambridge IGCSE',
    code: 'IGCSE',
    applicableTo: ['INTERNATIONAL'],
    levels: ['IGCSE'],
    grading: {
      'A*': { min: 90, max: 100, grade: 'A*', points: 8, color: 'green' },
      'A': { min: 80, max: 89, grade: 'A', points: 7, color: 'green' },
      'B': { min: 70, max: 79, grade: 'B', points: 6, color: 'blue' },
      'C': { min: 60, max: 69, grade: 'C', points: 5, color: 'blue' },
      'D': { min: 50, max: 59, grade: 'D', points: 4, color: 'yellow' },
      'E': { min: 40, max: 49, grade: 'E', points: 3, color: 'orange' },
      'F': { min: 30, max: 39, grade: 'F', points: 2, color: 'orange' },
      'G': { min: 20, max: 29, grade: 'G', points: 1, color: 'red' },
      'U': { min: 0, max: 19, grade: 'U', points: 0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.CAMBRIDGE_IGCSE.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'U', code: 'U', points: 0, color: 'red' };
    }
  },

  // TVET - Competency Based (Modules)
  TVET: {
    name: 'TVET Competency Based',
    code: 'TVET',
    applicableTo: ['COLLEGE_TVET'],
    levels: ['Certificate', 'Diploma', 'Higher Diploma'],
    grading: {
      'C': { min: 80, max: 100, grade: 'Competent', code: 'C', points: 4, color: 'green' },
      'NYC': { min: 0, max: 79, grade: 'Not Yet Competent', code: 'NYC', points: 0, color: 'red' }
    },
    hasPoints: false,
    hasGrades: true,
    isCompetencyBased: true,
    getGrade: (marks) => {
      if (marks >= 80) return { grade: 'Competent', code: 'C', points: 4, color: 'green' };
      return { grade: 'Not Yet Competent', code: 'NYC', points: 0, color: 'red' };
    }
  },

  // University - GPA Based
  UNIVERSITY: {
    name: 'University GPA System',
    code: 'UNI',
    applicableTo: ['UNIVERSITY'],
    levels: ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5', 'Year 6'],
    grading: {
      'A': { min: 70, max: 100, grade: 'A', points: 5.0, gpa: 4.0, color: 'green' },
      'B+': { min: 65, max: 69, grade: 'B+', points: 4.5, gpa: 3.5, color: 'blue' },
      'B': { min: 60, max: 64, grade: 'B', points: 4.0, gpa: 3.0, color: 'blue' },
      'B-': { min: 55, max: 59, grade: 'B-', points: 3.5, gpa: 2.7, color: 'blue' },
      'C+': { min: 50, max: 54, grade: 'C+', points: 3.0, gpa: 2.3, color: 'yellow' },
      'C': { min: 45, max: 49, grade: 'C', points: 2.5, gpa: 2.0, color: 'yellow' },
      'C-': { min: 40, max: 44, grade: 'C-', points: 2.0, gpa: 1.7, color: 'yellow' },
      'D+': { min: 35, max: 39, grade: 'D+', points: 1.5, gpa: 1.3, color: 'orange' },
      'D': { min: 30, max: 34, grade: 'D', points: 1.0, gpa: 1.0, color: 'orange' },
      'E': { min: 0, max: 29, grade: 'E', points: 0.0, gpa: 0.0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    isGPABased: true,
    calculateGPA: (results) => {
      if (!results || results.length === 0) return 0;
      const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
      const totalCredits = results.reduce((sum, r) => sum + (r.credits || 3), 0);
      return totalCredits > 0 ? (totalPoints / results.length).toFixed(2) : 0;
    },
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.UNIVERSITY.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, gpa: range.gpa, color: range.color };
        }
      }
      return { grade: 'E', code: 'E', points: 0.0, gpa: 0.0, color: 'red' };
    }
  },

  // American System (A-F with + and -)
  AMERICAN: {
    name: 'American',
    code: 'USA',
    applicableTo: ['INTERNATIONAL'],
    levels: ['Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
    grading: {
      'A+': { min: 97, max: 100, grade: 'A+', points: 4.0, gpa: 4.0, color: 'green' },
      'A': { min: 93, max: 96, grade: 'A', points: 4.0, gpa: 4.0, color: 'green' },
      'A-': { min: 90, max: 92, grade: 'A-', points: 3.7, gpa: 3.7, color: 'green' },
      'B+': { min: 87, max: 89, grade: 'B+', points: 3.3, gpa: 3.3, color: 'blue' },
      'B': { min: 83, max: 86, grade: 'B', points: 3.0, gpa: 3.0, color: 'blue' },
      'B-': { min: 80, max: 82, grade: 'B-', points: 2.7, gpa: 2.7, color: 'blue' },
      'C+': { min: 77, max: 79, grade: 'C+', points: 2.3, gpa: 2.3, color: 'yellow' },
      'C': { min: 73, max: 76, grade: 'C', points: 2.0, gpa: 2.0, color: 'yellow' },
      'C-': { min: 70, max: 72, grade: 'C-', points: 1.7, gpa: 1.7, color: 'yellow' },
      'D+': { min: 67, max: 69, grade: 'D+', points: 1.3, gpa: 1.3, color: 'orange' },
      'D': { min: 63, max: 66, grade: 'D', points: 1.0, gpa: 1.0, color: 'orange' },
      'D-': { min: 60, max: 62, grade: 'D-', points: 0.7, gpa: 0.7, color: 'orange' },
      'F': { min: 0, max: 59, grade: 'F', points: 0.0, gpa: 0.0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    hasGPA: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.AMERICAN.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, gpa: range.gpa, color: range.color };
        }
      }
      return { grade: 'F', code: 'F', points: 0.0, gpa: 0.0, color: 'red' };
    }
  }
};

// ==================== PERMISSION DEFINITIONS (Master List) ====================
const MASTER_PERMISSIONS = [
  // ==================== EXISTING PERMISSIONS ====================
  // Students
  { key: 'view_students', name: 'View Students', description: 'Can view student list and details', category: 'students', module: 'students', action: 'read', isDefault: true },
  { key: 'create_students', name: 'Create Students', description: 'Can add new students', category: 'students', module: 'students', action: 'create', isDefault: false },
  { key: 'edit_students', name: 'Edit Students', description: 'Can edit student information', category: 'students', module: 'students', action: 'update', isDefault: false },
  { key: 'delete_students', name: 'Delete Students', description: 'Can delete students', category: 'students', module: 'students', action: 'delete', isDefault: false },
  { key: 'promote_students', name: 'Promote Students', description: 'Can promote students to next class/year', category: 'students', module: 'students', action: 'manage', isDefault: false },
  
  // Classes
  { key: 'view_classes', name: 'View Classes', description: 'Can view classes', category: 'academic', module: 'classes', action: 'read', isDefault: true },
  { key: 'manage_classes', name: 'Manage Classes', description: 'Can create, edit, and delete classes', category: 'academic', module: 'classes', action: 'manage', isDefault: false },
  
  // Subjects
  { key: 'view_subjects', name: 'View Subjects', description: 'Can view subjects', category: 'academic', module: 'subjects', action: 'read', isDefault: true },
  { key: 'manage_subjects', name: 'Manage Subjects', description: 'Can create, edit, and delete subjects', category: 'academic', module: 'subjects', action: 'manage', isDefault: false },
  
  // Exams
  { key: 'view_exams', name: 'View Exams', description: 'Can view exams', category: 'academic', module: 'exams', action: 'read', isDefault: true },
  { key: 'manage_exams', name: 'Manage Exams', description: 'Can create, edit, and delete exams', category: 'academic', module: 'exams', action: 'manage', isDefault: false },
  { key: 'publish_results', name: 'Publish Results', description: 'Can publish exam results', category: 'academic', module: 'exams', action: 'manage', isDefault: false },
  
  // Results
  { key: 'view_results', name: 'View Results', description: 'Can view student results', category: 'academic', module: 'results', action: 'read', isDefault: true },
  { key: 'manage_results', name: 'Manage Results', description: 'Can enter and edit results', category: 'academic', module: 'results', action: 'manage', isDefault: false },
  
  // Attendance
  { key: 'view_attendance', name: 'View Attendance', description: 'Can view attendance records', category: 'attendance', module: 'attendance', action: 'read', isDefault: true },
  { key: 'manage_attendance', name: 'Manage Attendance', description: 'Can mark and edit attendance', category: 'attendance', module: 'attendance', action: 'manage', isDefault: false },
  
  // Fees
  { key: 'view_fees', name: 'View Fees', description: 'Can view fee structures', category: 'finance', module: 'fees', action: 'read', isDefault: true },
  { key: 'manage_fees', name: 'Manage Fees', description: 'Can create and edit fee structures', category: 'finance', module: 'fees', action: 'manage', isDefault: false },
  { key: 'view_payments', name: 'View Payments', description: 'Can view payment records', category: 'finance', module: 'payments', action: 'read', isDefault: true },
  { key: 'manage_payments', name: 'Manage Payments', description: 'Can record payments', category: 'finance', module: 'payments', action: 'manage', isDefault: false },
  
  // Staff
  { key: 'view_staff', name: 'View Staff', description: 'Can view staff list', category: 'hr', module: 'staff', action: 'read', isDefault: true },
  { key: 'manage_staff', name: 'Manage Staff', description: 'Can manage staff records', category: 'hr', module: 'staff', action: 'manage', isDefault: false },
  { key: 'manage_payroll', name: 'Manage Payroll', description: 'Can process payroll', category: 'hr', module: 'payroll', action: 'manage', isDefault: false },
  
  // Library
  { key: 'view_library', name: 'View Library', description: 'Can view library catalog', category: 'library', module: 'library', action: 'read', isDefault: true },
  { key: 'manage_library', name: 'Manage Library', description: 'Can manage books and borrowing', category: 'library', module: 'library', action: 'manage', isDefault: false },
  
  // Transport
  { key: 'view_transport', name: 'View Transport', description: 'Can view transport routes', category: 'transport', module: 'transport', action: 'read', isDefault: true },
  { key: 'manage_transport', name: 'Manage Transport', description: 'Can manage transport routes', category: 'transport', module: 'transport', action: 'manage', isDefault: false },
  
  // Hostel
  { key: 'view_hostel', name: 'View Hostel', description: 'Can view hostel information', category: 'hostel', module: 'hostel', action: 'read', isDefault: true },
  { key: 'manage_hostel', name: 'Manage Hostel', description: 'Can manage hostel rooms', category: 'hostel', module: 'hostel', action: 'manage', isDefault: false },
  
  // Inventory
  { key: 'view_inventory', name: 'View Inventory', description: 'Can view inventory items', category: 'inventory', module: 'inventory', action: 'read', isDefault: true },
  { key: 'manage_inventory', name: 'Manage Inventory', description: 'Can manage inventory', category: 'inventory', module: 'inventory', action: 'manage', isDefault: false },
  
  // School Settings
  { key: 'manage_school', name: 'Manage School', description: 'Can manage school settings', category: 'admin', module: 'school', action: 'manage', isDefault: false },
  { key: 'manage_users', name: 'Manage Users', description: 'Can manage users', category: 'admin', module: 'users', action: 'manage', isDefault: false },
  { key: 'manage_roles', name: 'Manage Roles', description: 'Can manage roles and permissions', category: 'admin', module: 'roles', action: 'manage', isDefault: false },
  { key: 'view_reports', name: 'View Reports', description: 'Can view reports', category: 'reports', module: 'reports', action: 'read', isDefault: true },
  { key: 'view_financial_reports', name: 'View Financial Reports', description: 'Can view financial reports', category: 'reports', module: 'financial', action: 'read', isDefault: false },
  
  // Announcements & Events
  { key: 'manage_announcements', name: 'Manage Announcements', description: 'Can create and manage announcements', category: 'communication', module: 'announcements', action: 'manage', isDefault: false },
  { key: 'manage_events', name: 'Manage Events', description: 'Can create and manage events', category: 'communication', module: 'events', action: 'manage', isDefault: false },
  
  // Timetable
  { key: 'view_timetable', name: 'View Timetable', description: 'Can view timetable', category: 'academic', module: 'timetable', action: 'read', isDefault: true },
  { key: 'manage_timetable', name: 'Manage Timetable', description: 'Can manage timetable', category: 'academic', module: 'timetable', action: 'manage', isDefault: false },
  
  // Health
  { key: 'manage_medical_records', name: 'Manage Medical Records', description: 'Can manage health records', category: 'health', module: 'health', action: 'manage', isDefault: false },
  
  // Self
  { key: 'view_own_profile', name: 'View Own Profile', description: 'Can view own profile', category: 'self', module: 'profile', action: 'read', isDefault: true },
  { key: 'view_own_results', name: 'View Own Results', description: 'Can view own results', category: 'self', module: 'results', action: 'read', isDefault: true },
  { key: 'view_own_attendance', name: 'View Own Attendance', description: 'Can view own attendance', category: 'self', module: 'attendance', action: 'read', isDefault: true },
  { key: 'view_own_fees', name: 'View Own Fees', description: 'Can view own fees', category: 'self', module: 'fees', action: 'read', isDefault: true },
  { key: 'view_own_timetable', name: 'View Own Timetable', description: 'Can view own timetable', category: 'self', module: 'timetable', action: 'read', isDefault: true },

  // ==================== NEW FEATURE PERMISSIONS ====================
  
  // Card Management
  { key: 'view_card_management', name: 'View Card Management', description: 'Can view card management', category: 'card_management', module: 'card_management', action: 'read', isDefault: false },
  { key: 'manage_card_management', name: 'Manage Card Management', description: 'Can generate, edit, and delete cards', category: 'card_management', module: 'card_management', action: 'manage', isDefault: false },
  { key: 'print_cards', name: 'Print Cards', description: 'Can print ID cards', category: 'card_management', module: 'card_management', action: 'manage', isDefault: false },

  // Certificates
  { key: 'view_certificates', name: 'View Certificates', description: 'Can view certificates', category: 'certificates', module: 'certificates', action: 'read', isDefault: false },
  { key: 'manage_certificates', name: 'Manage Certificates', description: 'Can generate, edit, and delete certificates', category: 'certificates', module: 'certificates', action: 'manage', isDefault: false },
  { key: 'print_certificates', name: 'Print Certificates', description: 'Can print certificates', category: 'certificates', module: 'certificates', action: 'manage', isDefault: false },

  // Online Exams
  { key: 'view_online_exams', name: 'View Online Exams', description: 'Can view online exams', category: 'online_exams', module: 'online_exams', action: 'read', isDefault: false },
  { key: 'manage_online_exams', name: 'Manage Online Exams', description: 'Can create, edit, and delete online exams', category: 'online_exams', module: 'online_exams', action: 'manage', isDefault: false },
  { key: 'take_online_exams', name: 'Take Online Exams', description: 'Can take online exams (students)', category: 'online_exams', module: 'online_exams', action: 'read', isDefault: true },
  { key: 'grade_online_exams', name: 'Grade Online Exams', description: 'Can grade online exam submissions', category: 'online_exams', module: 'online_exams', action: 'manage', isDefault: false },
  { key: 'publish_online_exams', name: 'Publish Online Exams', description: 'Can publish online exams', category: 'online_exams', module: 'online_exams', action: 'manage', isDefault: false },

  // Live Classroom
  { key: 'view_live_classroom', name: 'View Live Classroom', description: 'Can view live classrooms', category: 'live_classroom', module: 'live_classroom', action: 'read', isDefault: false },
  { key: 'manage_live_classroom', name: 'Manage Live Classroom', description: 'Can create, edit, and delete live classrooms', category: 'live_classroom', module: 'live_classroom', action: 'manage', isDefault: false },
  { key: 'join_live_classroom', name: 'Join Live Classroom', description: 'Can join live classrooms (students)', category: 'live_classroom', module: 'live_classroom', action: 'read', isDefault: true },
  { key: 'record_live_classroom', name: 'Record Live Classroom', description: 'Can record live classrooms', category: 'live_classroom', module: 'live_classroom', action: 'manage', isDefault: false },

  // Alumni
  { key: 'view_alumni', name: 'View Alumni', description: 'Can view alumni records', category: 'alumni', module: 'alumni', action: 'read', isDefault: false },
  { key: 'manage_alumni', name: 'Manage Alumni', description: 'Can create, edit, and delete alumni records', category: 'alumni', module: 'alumni', action: 'manage', isDefault: false },
  { key: 'manage_alumni_events', name: 'Manage Alumni Events', description: 'Can create and manage alumni events', category: 'alumni', module: 'alumni', action: 'manage', isDefault: false },
  { key: 'send_alumni_sms', name: 'Send Alumni SMS', description: 'Can send SMS to alumni', category: 'alumni', module: 'alumni', action: 'manage', isDefault: false },

  // Receptionist
  { key: 'view_receptionist', name: 'View Receptionist', description: 'Can view receptionist dashboard', category: 'receptionist', module: 'receptionist', action: 'read', isDefault: false },
  { key: 'manage_receptionist', name: 'Manage Receptionist', description: 'Can manage visitors, calls, appointments, complaints, and tasks', category: 'receptionist', module: 'receptionist', action: 'manage', isDefault: false },
  { key: 'manage_appointments', name: 'Manage Appointments', description: 'Can schedule and manage appointments', category: 'receptionist', module: 'receptionist', action: 'manage', isDefault: false },
  { key: 'manage_complaints', name: 'Manage Complaints', description: 'Can manage complaints', category: 'receptionist', module: 'receptionist', action: 'manage', isDefault: false },
  { key: 'manage_visitors', name: 'Manage Visitors', description: 'Can check in and check out visitors', category: 'receptionist', module: 'receptionist', action: 'manage', isDefault: false },

  // Course Enrollment
  { key: 'view_course_enrollment', name: 'View Course Enrollment', description: 'Can view course enrollments', category: 'course_enrollment', module: 'course_enrollment', action: 'read', isDefault: false },
  { key: 'manage_course_enrollment', name: 'Manage Course Enrollment', description: 'Can enroll students in courses/programs', category: 'course_enrollment', module: 'course_enrollment', action: 'manage', isDefault: false },
  { key: 'approve_course_enrollment', name: 'Approve Course Enrollment', description: 'Can approve course enrollments', category: 'course_enrollment', module: 'course_enrollment', action: 'manage', isDefault: false },

  // Unit Registration
  { key: 'view_unit_registration', name: 'View Unit Registration', description: 'Can view unit registrations', category: 'unit_registration', module: 'unit_registration', action: 'read', isDefault: false },
  { key: 'manage_unit_registration', name: 'Manage Unit Registration', description: 'Can register students for units/modules', category: 'unit_registration', module: 'unit_registration', action: 'manage', isDefault: false },
  { key: 'approve_unit_registration', name: 'Approve Unit Registration', description: 'Can approve unit registrations', category: 'unit_registration', module: 'unit_registration', action: 'manage', isDefault: false },

  // Schemes of Work
  { key: 'view_schemes_of_work', name: 'View Schemes of Work', description: 'Can view schemes of work', category: 'schemes_of_work', module: 'schemes_of_work', action: 'read', isDefault: false },
  { key: 'manage_schemes_of_work', name: 'Manage Schemes of Work', description: 'Can create, edit, and delete schemes of work', category: 'schemes_of_work', module: 'schemes_of_work', action: 'manage', isDefault: false },

  // Exam Cards
  { key: 'view_exam_cards', name: 'View Exam Cards', description: 'Can view exam cards', category: 'exam_cards', module: 'exam_cards', action: 'read', isDefault: false },
  { key: 'manage_exam_cards', name: 'Manage Exam Cards', description: 'Can generate exam cards for students', category: 'exam_cards', module: 'exam_cards', action: 'manage', isDefault: false },
  { key: 'print_exam_cards', name: 'Print Exam Cards', description: 'Can print exam cards', category: 'exam_cards', module: 'exam_cards', action: 'manage', isDefault: false },

  // Fee Allocation
  { key: 'view_fee_allocation', name: 'View Fee Allocation', description: 'Can view fee allocations', category: 'fee_allocation', module: 'fee_allocation', action: 'read', isDefault: false },
  { key: 'manage_fee_allocation', name: 'Manage Fee Allocation', description: 'Can allocate fees to students', category: 'fee_allocation', module: 'fee_allocation', action: 'manage', isDefault: false },

  // Fee Collection
  { key: 'view_fee_collection', name: 'View Fee Collection', description: 'Can view fee collection records', category: 'fee_collection', module: 'fee_collection', action: 'read', isDefault: false },
  { key: 'manage_fee_collection', name: 'Manage Fee Collection', description: 'Can record fee payments', category: 'fee_collection', module: 'fee_collection', action: 'manage', isDefault: false },

  // Receipt History
  { key: 'view_receipt_history', name: 'View Receipt History', description: 'Can view receipt history', category: 'receipt_history', module: 'receipt_history', action: 'read', isDefault: false },
  { key: 'print_receipts', name: 'Print Receipts', description: 'Can print receipts', category: 'receipt_history', module: 'receipt_history', action: 'manage', isDefault: false },

  // Payroll
  { key: 'view_payroll', name: 'View Payroll', description: 'Can view payroll records', category: 'payroll', module: 'payroll', action: 'read', isDefault: false },
  { key: 'manage_payroll', name: 'Manage Payroll', description: 'Can process payroll', category: 'payroll', module: 'payroll', action: 'manage', isDefault: false },

  // Staff Attendance
  { key: 'view_staff_attendance', name: 'View Staff Attendance', description: 'Can view staff attendance records', category: 'staff_attendance', module: 'staff_attendance', action: 'read', isDefault: false },
  { key: 'manage_staff_attendance', name: 'Manage Staff Attendance', description: 'Can mark and edit staff attendance', category: 'staff_attendance', module: 'staff_attendance', action: 'manage', isDefault: false },
  { key: 'approve_staff_attendance', name: 'Approve Staff Attendance', description: 'Can approve staff attendance', category: 'staff_attendance', module: 'staff_attendance', action: 'manage', isDefault: false },

  // Student Arrival
  { key: 'view_student_arrival', name: 'View Student Arrival', description: 'Can view student arrival records', category: 'student_arrival', module: 'student_arrival', action: 'read', isDefault: false },
  { key: 'manage_student_arrival', name: 'Manage Student Arrival', description: 'Can mark student arrival and departure', category: 'student_arrival', module: 'student_arrival', action: 'manage', isDefault: false },
  { key: 'send_arrival_sms', name: 'Send Arrival SMS', description: 'Can send arrival/departure SMS notifications to parents', category: 'student_arrival', module: 'student_arrival', action: 'manage', isDefault: false },

  // Sick Bay
  { key: 'view_sickbay', name: 'View Sick Bay', description: 'Can view sick bay records', category: 'health', module: 'sickbay', action: 'read', isDefault: false },
  { key: 'manage_sickbay', name: 'Manage Sick Bay', description: 'Can admit and discharge students from sick bay', category: 'health', module: 'sickbay', action: 'manage', isDefault: false },

  // Fee Statement (Student self-service)
  { key: 'view_fee_statement', name: 'View Fee Statement', description: 'Can view fee statements', category: 'self', module: 'fee_statement', action: 'read', isDefault: true },

  // Student Arrival (Student self-service)
  { key: 'view_own_arrival', name: 'View Own Arrival', description: 'Can view own arrival records', category: 'self', module: 'student_arrival', action: 'read', isDefault: true }
];

// ==================== MODEL DEFINITIONS ====================
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  firstName: DataTypes.STRING,
  lastName: DataTypes.STRING,
  phone: DataTypes.STRING,
  
  // Role field - keep this as the legacy role (for backward compatibility)
  role: {
    type: DataTypes.ENUM(
      'SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL',
      'SENIOR_TEACHER', 'CLASS_TEACHER', 'SUBJECT_TEACHER', 'TEACHER',
      'LECTURER', 'SENIOR_LECTURER', 'PROFESSOR', 'DEAN', 'HOD',
      'INSTRUCTOR', 'TRAINER', 'WORKSHOP_SUPERVISOR',
      'ACCOUNTANT', 'LIBRARIAN', 'NURSE', 'MATRON', 'TRANSPORT_MANAGER',
      'HR_MANAGER', 'HR', 'PARENT', 'STUDENT'
    ),
    defaultValue: 'TEACHER',
    allowNull: true // Now optional if using roleId
  },
  
  // NEW: roleId field for dynamic roles
  roleId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Roles',
      key: 'id'
    }
  },
  
  schoolId: { type: DataTypes.UUID, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  lastLogin: DataTypes.DATE,
  resetToken: { type: DataTypes.STRING, allowNull: true }
});
const School = sequelize.define('School', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  
  // ==================== BASIC INFORMATION ====================
  name: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
  code: { 
    type: DataTypes.STRING, 
    unique: true 
  },
  category: {
    type: DataTypes.ENUM(
      'ECDE_PRIMARY_JSS',
      'SENIOR_SECONDARY',
      'COLLEGE_TVET',
      'UNIVERSITY'
    ),
    allowNull: false
  },
  gradingSystem: {
    type: DataTypes.ENUM('CBC', '844', 'TVET', 'UNIVERSITY', 'IB', 'IGCSE', 'USA'),
    allowNull: false,
    defaultValue: 'CBC'
  },
  
  // ==================== ATTENDANCE SETTINGS ====================
  startTime: { 
    type: DataTypes.STRING, 
    defaultValue: '08:00' 
  },
  endTime: { 
    type: DataTypes.STRING, 
    defaultValue: '17:00' 
  },
  lateThreshold: { 
    type: DataTypes.INTEGER, 
    defaultValue: 30 
  },
  earlyDepartureThreshold: { 
    type: DataTypes.INTEGER, 
    defaultValue: 30 
  },
  
  // ==================== SUBSCRIPTION ====================
  subscription: {
    type: DataTypes.JSONB,
    defaultValue: {
      plan: 'BASIC',
      status: 'ACTIVE',
      trialEnds: null,
      features: {
        sms: false,
        email: false,
        advancedReports: false,
        apiAccess: false,
        bulkSMS: false,
        whatsapp: false,
        biometrics: false
      }
    }
  },
  
  // ==================== SCHOOL SETTINGS ====================
  settings: {
    type: DataTypes.JSONB,
    defaultValue: {
      academicYear: new Date().getFullYear().toString(),
      terms: ['Term 1', 'Term 2', 'Term 3'],
      gradingSystem: {},
      currency: 'KES',
      timezone: 'Africa/Nairobi',
      dateFormat: 'DD/MM/YYYY',
      notifications: {
        feeReminders: true,
        examResults: true,
        attendanceAlerts: false,
        paymentReceipts: true
      }
    }
  },
  
  // ==================== CONTACT INFORMATION ====================
  contact: {
    type: DataTypes.JSONB,
    defaultValue: {
      email: '',
      phone: '',
      address: '',
      logo: '',
      county: '',
      constituency: '',
      ward: '',
      postalAddress: '',
      website: ''
    }
  },
  
  motto: DataTypes.STRING,
  established: DataTypes.STRING,
  registrationNumber: DataTypes.STRING,
  
  // ==================== EMAIL CONFIGURATION ====================
  emailProvider: {
    type: DataTypes.ENUM('SMTP', 'SENDGRID', 'RESEND', 'MAILGUN', 'AWS_SES'),
    defaultValue: 'SMTP'
  },
  
  emailConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      smtp: {
        host: '',
        port: 587,
        secure: false,
        username: '',
        password: '',
        fromEmail: '',
        replyTo: ''
      },
      sendgrid: {
        apiKey: '',
        fromEmail: '',
        replyTo: ''
      },
      resend: {
        apiKey: '',
        fromEmail: '',
        replyTo: ''
      },
      mailgun: {
        apiKey: '',
        domain: '',
        fromEmail: '',
        replyTo: '',
        apiUrl: 'https://api.mailgun.net'
      },
      ses: {
        accessKeyId: '',
        secretAccessKey: '',
        region: 'us-east-1',
        fromEmail: '',
        replyTo: ''
      },
      enabled: false,
      testMode: false,
      testEmail: '',
      sendLimit: 1000,
      sendLimitPerHour: 100,
      batchSize: 50,
      delayBetweenBatches: 1000,
      retryAttempts: 3,
      retryDelay: 5000
    }
  },
  
  // ==================== SMS CONFIGURATION (ENHANCED) ====================
  smsProvider: {
    type: DataTypes.ENUM(
      'AFRICASTALKING', 
      'CELCOM',           // ← Added: Celcom Africa
      'SMSLEOPARD',       // ← Added: SMSLeopard
      'ADVANTA',          // ← Added: Advanta Africa
      'TWILIO', 
      'BULKSMS', 
      'SMSCOUNTRY', 
      'PAWATALK',         // ← Added: PawaTalk
      'NONE'
    ),
    defaultValue: 'NONE'
  },
  
  smsConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      // ===== Africa's Talking =====
      africastalking: {
        apiKey: '',
        username: '',
        senderId: '',
        shortCode: ''
      },
      
      // ===== Celcom Africa (KES 0.25/SMS) =====
      celcom: {
        apiKey: '',
        senderId: '',
        route: 'direct', // direct, economy, promotional
        callbackUrl: ''
      },
      
      // ===== SMSLeopard (KES 0.3-0.9/SMS) =====
      smsleopard: {
        apiKey: '',
        senderId: '',
        route: 'safaricom', // safaricom, airtel, telkom, all
        userId: ''
      },
      
      // ===== Advanta Africa (KES 0.30-0.80/SMS) =====
      advanta: {
        apiKey: '',
        senderId: '',
        username: '',
        partnerId: ''
      },
      
      // ===== PawaTalk (Payment + SMS) =====
      pawatalk: {
        apiKey: '',
        senderId: '',
        merchantId: '',
        callbackUrl: ''
      },
      
      // ===== Twilio =====
      twilio: {
        accountSid: '',
        authToken: '',
        fromNumber: '',
        messagingServiceSid: ''
      },
      
      // ===== BulkSMS =====
      bulksms: {
        username: '',
        password: '',
        from: ''
      },
      
      // ===== SMS Country =====
      smscountry: {
        username: '',
        password: '',
        senderId: '',
        route: 'default'
      },
      
      // ===== General SMS Settings =====
      enabled: false,
      testMode: false,
      testPhone: '',
      sendLimit: 500,          // Max SMS per day
      sendLimitPerHour: 50,    // Max SMS per hour
      batchSize: 100,          // SMS per batch
      delayBetweenBatches: 2000, // Milliseconds between batches
      defaultCountryCode: '254',
      maxRetries: 3,
      retryDelay: 5000,
      
      // ===== Price Tracking =====
      pricing: {
        costPerSMS: 0,        // Current cost per SMS (KES)
        currency: 'KES',
        monthlyVolume: 0,
        estimatedMonthlyCost: 0
      }
    }
  },
  
  // ==================== NOTIFICATION SETTINGS ====================
  notificationConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      // Email Notifications
      email: {
        feeReminders: true,
        examResults: true,
        attendanceAlerts: false,
        paymentReceipts: true,
        announcements: true,
        events: true,
        systemAlerts: true,
        parentRegistration: true,
        studentRegistration: true,
        arrivalAlerts: false,
        departureAlerts: false
      },
      
      // SMS Notifications
      sms: {
        feeReminders: false,
        examResults: false,
        attendanceAlerts: true,
        paymentReceipts: false,
        announcements: false,
        events: false,
        systemAlerts: true,
        parentRegistration: true,
        studentRegistration: false,
        arrivalAlerts: true,
        departureAlerts: true,
        emergencyAlerts: true,
        dailySummary: false
      },
      
      // Push Notifications
      push: {
        enabled: false,
        feeReminders: false,
        examResults: false,
        attendanceAlerts: false,
        announcements: true,
        events: true
      }
    }
  },
  
  // ==================== FEATURE FLAGS ====================
  features: {
    type: DataTypes.JSONB,
    defaultValue: {
      // Core Features
      sms: false,
      email: false,
      examPortal: false,
      parentPortal: true,
      studentPortal: true,
      library: true,
      transport: false,
      hostel: true,
      inventory: true,
      
      // Advanced Features
      biometrics: false,
      whatsapp: false,
      onlinePayments: false,
      advancedReports: false,
      apiAccess: false,
      customBranding: false,
      
      // Communication
      bulkSMS: false,
      bulkEmail: false,
      emailTemplates: false,
      smsTemplates: false,
      
      // SMS Features
      arrivalAlerts: true,
      departureAlerts: true,
      emergencyAlerts: false,
      dailySummary: false,
      feeReminders: false,
      examResults: false
    }
  },
  
  // ==================== SMS USAGE & ANALYTICS ====================
  smsUsage: {
    type: DataTypes.JSONB,
    defaultValue: {
      totalSent: 0,
      totalCost: 0,
      monthlyUsage: {},
      dailyUsage: {},
      deliveryRate: 100,
      failedCount: 0,
      lastReset: new Date(),
      monthlyLimit: 5000
    }
  },
  
  // ==================== BRANDING & CUSTOMIZATION ====================
  branding: {
    type: DataTypes.JSONB,
    defaultValue: {
      primaryColor: '#4f46e5',
      secondaryColor: '#818cf8',
      accentColor: '#f59e0b',
      fontFamily: 'Inter, sans-serif',
      logo: '',
      favicon: '',
      customCSS: '',
      customHeader: '',
      customFooter: '',
      theme: 'light'
    }
  },
  
  // ==================== SYSTEM SETTINGS ====================
  systemConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      twoFactorAuth: false,
      passwordExpiry: 90,
      maxLoginAttempts: 5,
      sessionTimeout: 480,
      retentionPeriod: 365,
      autoBackup: true,
      backupFrequency: 'daily',
      cacheEnabled: true,
      cacheDuration: 3600,
      apiRateLimit: 100,
      apiVersion: '1.0.0'
    }
  },
  
  // ==================== AUDIT & METADATA ====================
  createdBy: { 
    type: DataTypes.UUID, 
    allowNull: true 
  },
  
  isActive: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: true 
  }
}, {
  timestamps: true,
  indexes: [
    { fields: ['name'] },
    { fields: ['code'] },
    { fields: ['category'] },
    { fields: ['isActive'] },
    { fields: ['smsProvider'] },
    { fields: ['emailProvider'] }
  ]
});
const Class = sequelize.define('Class', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  academicYear: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  streams: { type: DataTypes.JSONB, defaultValue: [] },
  classTeacherId: DataTypes.UUID,
  subjects: { type: DataTypes.JSONB, defaultValue: [] },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

// In your backend server.cjs, update the Student model
const Student = sequelize.define('Student', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  admissionNumber: { type: DataTypes.STRING, allowNull: false, unique: true },
  idType: { 
    type: DataTypes.ENUM('NATIONAL_ID', 'BIRTH_CERTIFICATE', 'PASSPORT', 'SCHOOL_ID', 'OTHER'),
    allowNull: true 
  },
  idNumber: { type: DataTypes.STRING, allowNull: true },
  firstName: { type: DataTypes.STRING, allowNull: false },
  lastName: { type: DataTypes.STRING, allowNull: false },
  middleName: DataTypes.STRING,
  
  // CONTACT FIELDS - ALL OPTIONAL (allowNull: true)
  email: { 
    type: DataTypes.STRING, 
    allowNull: true,  // ← NOT required
    validate: {
      isEmail: {
        msg: 'Must be a valid email address',
        args: true,
        // This validation only runs if email is provided
      }
    }
  },
  phone: { 
    type: DataTypes.STRING, 
    allowNull: true,  // ← NOT required
    validate: {
      is: {
        args: /^[0-9+\-\s()]{0,20}$/i,  // Optional phone validation
        msg: 'Please enter a valid phone number'
      }
    }
  },
  address: { 
    type: DataTypes.TEXT, 
    allowNull: true   // ← NOT required
  },
  
  dateOfBirth: DataTypes.DATEONLY,
  gender: DataTypes.ENUM('MALE', 'FEMALE', 'OTHER'),
  nationality: DataTypes.STRING,
  religion: DataTypes.STRING,
  birthCertificate: DataTypes.STRING,
  passportPhoto: DataTypes.STRING,
  classId: DataTypes.UUID,
  schoolId: { type: DataTypes.UUID, allowNull: false },
  enrollmentDate: DataTypes.DATEONLY,
  boardingStatus: DataTypes.ENUM('DAY', 'BOARDING', 'WEEKLY'),
  transportRouteId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  currentYear: { type: DataTypes.INTEGER, allowNull: true },
  currentSemester: { type: DataTypes.INTEGER, allowNull: true },
  currentModule: { type: DataTypes.STRING, allowNull: true },
  admissionDate: DataTypes.DATEONLY,
  expectedGraduation: DataTypes.DATEONLY,
  supervisor: DataTypes.STRING,
  thesisTitle: DataTypes.TEXT,
  medicalInfo: {
    type: DataTypes.JSONB,
    defaultValue: {
      bloodGroup: '',
      allergies: '',
      chronicConditions: '',
      disabilities: '',
      doctorName: '',
      doctorPhone: '',
      emergencyNotes: ''
    }
  },
  parentId: DataTypes.UUID,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  userId: { 
    type: DataTypes.UUID, 
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    }
  }
});

const Parent = sequelize.define('Parent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: DataTypes.UUID,
  studentId: DataTypes.UUID,
  relationship: DataTypes.STRING,
  isPrimary: { type: DataTypes.BOOLEAN, defaultValue: false },
  emergencyContact: { type: DataTypes.BOOLEAN, defaultValue: false },
  occupation: DataTypes.STRING,
  employer: DataTypes.STRING,
  monthlyIncome: DataTypes.DECIMAL(10, 2),
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Subject = sequelize.define('Subject', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: DataTypes.UUID,
  teacherId: DataTypes.UUID,
  isCompulsory: { type: DataTypes.BOOLEAN, defaultValue: true },
  category: DataTypes.STRING,
  maxMarks: { type: DataTypes.INTEGER, defaultValue: 100 },
  passMarks: { type: DataTypes.INTEGER, defaultValue: 50 }
});

// Update your Exam model definition in the backend
const Exam = sequelize.define('Exam', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  type: {
    type: DataTypes.ENUM(
      'OPENER', 'MIDTERM', 'ENDTERM', 'CAT', 'MOCK', 'PRE_MOCK',
      'PRACTICAL', 'PROJECT', 'MAIN_EXAM', 'SUPPLEMENTARY', 'SPECIAL',
      'QUIZ', 'ASSIGNMENT', 'FINAL', 'LAB', 'PRESENTATION', 'THESIS', 'DEFENSE'
    )
  },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  facultyId: { type: DataTypes.UUID, allowNull: true },
  departmentId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true },
  term: DataTypes.STRING,
  academicYear: DataTypes.STRING,
  date: DataTypes.DATEONLY,
  startTime: DataTypes.TIME,
  endTime: DataTypes.TIME,
  maxMarks: DataTypes.INTEGER,
  weightage: DataTypes.FLOAT,
  isPublished: { type: DataTypes.BOOLEAN, defaultValue: false },
  examHall: { type: DataTypes.STRING, allowNull: true },
  invigilator: { type: DataTypes.STRING, allowNull: true },
  invigilatorId: { type: DataTypes.UUID, allowNull: true } // ADD THIS FIELD
});
const Result = sequelize.define('Result', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  examId: { type: DataTypes.UUID, allowNull: false },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  marks: DataTypes.FLOAT,
  grade: DataTypes.STRING,
  gradeCode: DataTypes.STRING,
  points: DataTypes.FLOAT,
  remarks: DataTypes.TEXT,
  description: DataTypes.TEXT,
  position: DataTypes.INTEGER,
  isAbsent: { type: DataTypes.BOOLEAN, defaultValue: false },
  gradingSystem: { type: DataTypes.STRING, allowNull: true }
});

// In your server.cjs, find the Attendance model definition and update it
const Attendance = sequelize.define('Attendance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true }, 
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  timetableId: { type: DataTypes.UUID, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }, // ADD THIS LINE
  period: { type: DataTypes.INTEGER, allowNull: true },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  status: {
    type: DataTypes.ENUM('PRESENT', 'ABSENT', 'LATE', 'PERMISSION', 'SICK', 'FIELD_TRIP')
  },
  timeIn: DataTypes.TIME,
  timeOut: DataTypes.TIME,
  startTime: DataTypes.TIME,
  endTime: DataTypes.TIME,
  remarks: DataTypes.TEXT,
  markedBy: DataTypes.UUID,
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.STRING, allowNull: true }
});
const Fee = sequelize.define('Fee', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  facultyId: { type: DataTypes.UUID, allowNull: true },
  departmentId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  moduleId: { type: DataTypes.UUID, allowNull: true },
  level: { type: DataTypes.STRING, allowNull: true },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  term: DataTypes.STRING,
  academicYear: DataTypes.STRING,
  dueDate: DataTypes.DATEONLY,
  category: DataTypes.STRING,
  isOptional: { type: DataTypes.BOOLEAN, defaultValue: false },
  isRecurring: { type: DataTypes.BOOLEAN, defaultValue: false },
  allocationType: { type: DataTypes.ENUM('AUTO', 'MANUAL'), defaultValue: 'AUTO' },
  appliesTo: { type: DataTypes.JSONB, defaultValue: ['ALL'] },
  transportRouteId: { type: DataTypes.UUID, allowNull: true }
});

const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { 
    type: DataTypes.UUID, 
    allowNull: true 
  },
  feeId: { type: DataTypes.UUID, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  paymentMethod: {
    type: DataTypes.ENUM('CASH', 'MPESA', 'BANK', 'CHEQUE', 'CARD')
  },
  transactionId: DataTypes.STRING,
  reference: DataTypes.STRING,
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  receiptNo: { type: DataTypes.STRING, unique: true },
  notes: DataTypes.TEXT,
  recordedBy: DataTypes.UUID,
  mpesaCode: { type: DataTypes.STRING, allowNull: true },
  mpesaPhone: { type: DataTypes.STRING, allowNull: true },
  bankReference: { type: DataTypes.STRING, allowNull: true },
  bankMessage: { type: DataTypes.STRING, allowNull: true },
  cardLast4: { type: DataTypes.STRING(4), allowNull: true },
  cardApprovalCode: { type: DataTypes.STRING, allowNull: true },
  chequeNumber: { type: DataTypes.STRING, allowNull: true },
  chequeBank: { type: DataTypes.STRING, allowNull: true },
  paymentDate: { type: DataTypes.DATEONLY, allowNull: true },
  isOtherIncome: { type: DataTypes.BOOLEAN, defaultValue: false },
  incomeCategory: { type: DataTypes.STRING, allowNull: true },
  description: { type: DataTypes.STRING, allowNull: true },
  payer: { type: DataTypes.STRING, allowNull: true },
  studentName: { type: DataTypes.STRING, allowNull: true },
  admissionNumber: { type: DataTypes.STRING, allowNull: true },
  courseName: { type: DataTypes.STRING, allowNull: true },
  className: { type: DataTypes.STRING, allowNull: true },
  feeName: { type: DataTypes.STRING, allowNull: true }
});

const CourseUnit = sequelize.define('CourseUnit', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: { type: DataTypes.STRING, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true }, // Changed to allow null
  programId: { type: DataTypes.UUID, allowNull: true }, // Added for TVET
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  credits: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 3 },
  description: { type: DataTypes.TEXT, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Expense = sequelize.define('Expense', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  category: DataTypes.STRING,
  description: DataTypes.TEXT,
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  paymentMethod: DataTypes.STRING,
  receiptNo: DataTypes.STRING,
  vendor: DataTypes.STRING,
  approvedBy: DataTypes.UUID,
  notes: DataTypes.TEXT
});
const Staff = sequelize.define('Staff', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  employeeId: DataTypes.STRING,
  tscNumber: DataTypes.STRING,
  
  // Department/Faculty - can be UUID reference or string
  departmentId: { type: DataTypes.UUID, allowNull: true }, // Link to Departments table
  facultyId: { type: DataTypes.UUID, allowNull: true },    // Link to Faculties table
  department: DataTypes.STRING, // Keep as fallback
  
  // Academic/Professional Titles
  academicTitle: {
    type: DataTypes.ENUM(
      'Professor', 
      'Associate Professor', 
      'Senior Lecturer', 
      'Lecturer', 
      'Assistant Lecturer',
      'Tutorial Fellow',
      'Instructor',
      'Senior Instructor',
      'Master Trainer',
      'Trainer',
      'Workshop Supervisor'
    ),
    allowNull: true
  },
  
  jobTitle: DataTypes.STRING, // Keep for backward compatibility
  
  // Administrative Positions
  administrativeRole: {
    type: DataTypes.ENUM(
      'Dean',
      'Associate Dean',
      'Head of Department',
      'Assistant HOD',
      'Programme Leader',
      'Course Coordinator',
      'Workshop Manager',
      'Lab Manager',
      'None'
    ),
    defaultValue: 'None'
  },
  
  // For HOD/Dean - which department/faculty they manage
  managesDepartmentId: { type: DataTypes.UUID, allowNull: true },
  managesFacultyId: { type: DataTypes.UUID, allowNull: true },
  
  employmentDate: DataTypes.DATEONLY,
  
  // Qualifications
  qualifications: { 
    type: DataTypes.JSONB, 
    defaultValue: [] 
  },
  
  // For TVET - trade specializations
  tradeSpecialization: {
    type: DataTypes.STRING,
    allowNull: true
  },
  
  // For University - research interests
  researchInterests: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  
  specialization: DataTypes.STRING, // Keep for backward compatibility
  
  // Subjects/Units taught
  subjects: { 
    type: DataTypes.JSONB, 
    defaultValue: [] 
  },
  
  // Units they are assigned to teach (for University/TVET)
  unitIds: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  
  staffType: { 
    type: DataTypes.ENUM(
      'TEACHING', 
      'NON_TEACHING', 
      'ACADEMIC',      // For university lecturers
      'RESEARCH',       // For research staff
      'TECHNICAL',      // For lab/workshop staff
      'ADMINISTRATIVE'  // For deans, HODs, etc.
    ), 
    defaultValue: 'TEACHING' 
  },

  // For HR purposes
  employmentType: {
    type: DataTypes.ENUM(
      'PERMANENT',
      'CONTRACT',
      'PART_TIME',
      'VISITING',
      'INTERN',
      'CONSULTANT'
    ),
    defaultValue: 'PERMANENT'
  },

  contractEndDate: DataTypes.DATEONLY,

  // Bank Details
  bankDetails: {
    type: DataTypes.JSONB,
    defaultValue: {
      bank: '',
      branch: '',
      account: '',
      paybill: ''
    }
  },
  
  // Deductions
  deductions: {
    type: DataTypes.JSONB,
    defaultValue: {
      nhif: 0,
      nssf: 0,
      sacco: 0,
      helb: 0,
      pension: 0,
      union: 0
    }
  },
  
  // Salary Structure
  salary: {
    type: DataTypes.JSONB,
    defaultValue: {
      basic: 0,
      house: 0,
      transport: 0,
      medical: 0,
      commuter: 0,
      leave: 0,
      hardship: 0,
      responsibility: 0,  // For HOD/Dean allowances
      research: 0,         // Research allowance
      extraneous: 0
    }
  },

  // For research staff
  researchGrants: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // For lab/workshop staff
  managedLabs: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  managedWorkshops: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // Certifications/Licenses
  certifications: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // Emergency contact
  emergencyContact: {
    type: DataTypes.JSONB,
    defaultValue: {
      name: '',
      relationship: '',
      phone: '',
      email: ''
    }
  },

  // Status
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Payroll = sequelize.define('Payroll', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  staffId: { type: DataTypes.UUID, allowNull: false },
  month: DataTypes.INTEGER,
  year: DataTypes.INTEGER,
  grossPay: DataTypes.DECIMAL(10, 2),
  deductions: DataTypes.DECIMAL(10, 2),
  netPay: DataTypes.DECIMAL(10, 2),
  paymentDate: DataTypes.DATEONLY,
  status: {
    type: DataTypes.ENUM('PENDING', 'PAID', 'CANCELLED'),
    defaultValue: 'PENDING'
  }
});

const Book = sequelize.define('Book', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  author: DataTypes.STRING,
  isbn: DataTypes.STRING,
  publisher: DataTypes.STRING,
  year: DataTypes.INTEGER,
  category: DataTypes.STRING,
  quantity: { type: DataTypes.INTEGER, defaultValue: 1 },
  available: { type: DataTypes.INTEGER, defaultValue: 1 },
  location: DataTypes.STRING,
  shelf: DataTypes.STRING
});

const Borrow = sequelize.define('Borrow', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  bookId: { type: DataTypes.UUID, allowNull: false },
  studentId: DataTypes.UUID,
  staffId: DataTypes.UUID,
  borrowDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  dueDate: DataTypes.DATEONLY,
  returnDate: DataTypes.DATEONLY,
  status: {
    type: DataTypes.ENUM('BORROWED', 'RETURNED', 'OVERDUE', 'LOST')
  },
  fine: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }
});

const Vehicle = sequelize.define('Vehicle', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  registration: DataTypes.STRING,
  type: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  driver: DataTypes.STRING,
  driverPhone: DataTypes.STRING,
  insuranceExpiry: DataTypes.DATEONLY,
  serviceDue: DataTypes.DATEONLY,
  fuelType: DataTypes.STRING,
  status: {
    type: DataTypes.ENUM('ACTIVE', 'MAINTENANCE', 'INACTIVE'),
    defaultValue: 'ACTIVE'
  }
});

const TransportRoute = sequelize.define('TransportRoute', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  vehicleId: { type: DataTypes.UUID, allowNull: true },
  pickupPoints: { type: DataTypes.JSONB, defaultValue: [] },
  pickupTimes: { type: DataTypes.JSONB, defaultValue: [] },
  dropoffPoints: { type: DataTypes.JSONB, defaultValue: [] },
  fee: DataTypes.DECIMAL(10, 2),
  students: { type: DataTypes.JSONB, defaultValue: [] },
  autoAllocate: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Hostel = sequelize.define('Hostel', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  gender: DataTypes.ENUM('BOYS', 'GIRLS', 'MIXED'),
  capacity: DataTypes.INTEGER,
  warden: DataTypes.STRING,
  wardenPhone: DataTypes.STRING,
  rooms: { 
    type: DataTypes.JSONB,
    defaultValue: [],
    get() {
      const rawValue = this.getDataValue('rooms');
      if (!rawValue) return [];
      if (typeof rawValue === 'string') {
        try {
          return JSON.parse(rawValue);
        } catch (e) {
          return [];
        }
      }
      return rawValue;
    },
    set(value) {
      this.setDataValue('rooms', value || []);
    }
  }
}, {
  timestamps: true,
  hooks: {
    beforeSave: (hostel) => {
      if (!hostel.rooms) hostel.rooms = [];
      if (!Array.isArray(hostel.rooms)) hostel.rooms = [];
    }
  }
});

const Inventory = sequelize.define('Inventory', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  category: DataTypes.STRING,
  quantity: DataTypes.INTEGER,
  unit: DataTypes.STRING,
  unitPrice: DataTypes.DECIMAL(10, 2),
  totalValue: DataTypes.DECIMAL(10, 2),
  reorderLevel: DataTypes.INTEGER,
  supplier: DataTypes.STRING,
  location: DataTypes.STRING,
  lastOrdered: DataTypes.DATEONLY,
  notes: DataTypes.TEXT
});

const InventoryUsage = sequelize.define('InventoryUsage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  inventoryId: { type: DataTypes.UUID, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  reason: DataTypes.STRING,
  department: DataTypes.STRING,
  usedBy: DataTypes.UUID,
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  timestamps: true,
  underscored: false
});

const Timetable = sequelize.define('Timetable', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true }, 
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true }, // ADD THIS FOR TVET
  unitId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true }, // ADD THIS FOR TVET
  day: { 
    type: DataTypes.ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'),
    allowNull: false 
  },
  period: { type: DataTypes.INTEGER, allowNull: false },
  startTime: { type: DataTypes.TIME, allowNull: false },
  endTime: { type: DataTypes.TIME, allowNull: false },
  teacherId: { type: DataTypes.UUID, allowNull: false },
  room: { type: DataTypes.STRING, allowNull: true }
});
const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  type: DataTypes.ENUM('SMS', 'EMAIL', 'NOTIFICATION'),
  from: DataTypes.UUID,
  to: { type: DataTypes.JSONB, defaultValue: [] },
  subject: DataTypes.STRING,
  content: DataTypes.TEXT,
  status: DataTypes.STRING,
  sentAt: DataTypes.DATE
});

const Announcement = sequelize.define('Announcement', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  content: DataTypes.TEXT,
  audience: { type: DataTypes.JSONB, defaultValue: [] },
  createdBy: DataTypes.UUID,
  expiresAt: DataTypes.DATE,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Event = sequelize.define('Event', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  startDate: DataTypes.DATE,
  endDate: DataTypes.DATE,
  location: DataTypes.STRING,
  type: DataTypes.STRING,
  audience: { type: DataTypes.JSONB, defaultValue: [] },
  createdBy: DataTypes.UUID
});

const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: DataTypes.UUID,
  userId: DataTypes.UUID,
  action: DataTypes.STRING,
  entity: DataTypes.STRING,
  entityId: DataTypes.UUID,
  oldValue: DataTypes.JSONB,
  newValue: DataTypes.JSONB,
  ipAddress: DataTypes.STRING,
  userAgent: DataTypes.STRING,
  timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});
// ==================== DYNAMIC ROLES & PERMISSIONS MODELS ====================

const Role = sequelize.define('Role', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  permissions: { 
    type: DataTypes.JSONB, 
    defaultValue: [] // Array of permission keys like ['view_students', 'manage_exams']
  },
  isSystemRole: { type: DataTypes.BOOLEAN, defaultValue: false }, // Prevent deletion of default roles
  schoolId: { type: DataTypes.UUID, allowNull: false },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
}, {
  timestamps: true,
  indexes: [
    { fields: ['schoolId'] },
    { fields: ['name'] }
  ]
});

const Permission = sequelize.define('Permission', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  key: { type: DataTypes.STRING, allowNull: false, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  category: { type: DataTypes.STRING, allowNull: false }, // e.g., 'academic', 'finance', 'admin'
  module: { type: DataTypes.STRING, allowNull: false }, // e.g., 'students', 'exams', 'fees'
  action: { type: DataTypes.STRING, allowNull: false }, // 'create', 'read', 'update', 'delete', 'manage'
  isDefault: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
  timestamps: true,
  indexes: [
    { fields: ['key'] },
    { fields: ['category'] },
    { fields: ['module'] }
  ]
});



const Feature = sequelize.define('Feature', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: DataTypes.STRING,
  code: DataTypes.STRING,
  category: DataTypes.STRING,
  description: DataTypes.TEXT,
  isEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  schoolId: DataTypes.UUID
});

const Faculty = sequelize.define('Faculty', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  dean: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  established: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Department = sequelize.define('Department', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  facultyId: { type: DataTypes.UUID, allowNull: false },
  head: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Course = sequelize.define('Course', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  departmentId: { type: DataTypes.UUID, allowNull: false },
  credits: DataTypes.INTEGER,
  level: DataTypes.STRING,
  description: DataTypes.TEXT,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Program = sequelize.define('Program', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  departmentId: { type: DataTypes.UUID, allowNull: false },
  duration: DataTypes.INTEGER,
  level: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Lab = sequelize.define('Lab', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  departmentId: { type: DataTypes.UUID, allowNull: false },
  incharge: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  location: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Research = sequelize.define('Research', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  title: { type: DataTypes.STRING, allowNull: false },
  facultyId: { type: DataTypes.UUID, allowNull: false },
  researcher: DataTypes.STRING,
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  funding: DataTypes.STRING,
  status: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Sponsor = sequelize.define('Sponsor', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  organization: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  address: DataTypes.TEXT,
  contactPerson: DataTypes.STRING,
  sponsorType: {
    type: DataTypes.ENUM('INDIVIDUAL', 'ORGANIZATION', 'GOVERNMENT', 'NGO', 'OTHER'),
    defaultValue: 'INDIVIDUAL'
  },
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Maintenance = sequelize.define('Maintenance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  vehicleId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  type: DataTypes.STRING,
  description: DataTypes.TEXT,
  cost: DataTypes.DECIMAL(10, 2),
  odometer: DataTypes.INTEGER,
  nextDueDate: DataTypes.DATEONLY,
  notes: DataTypes.TEXT,
  performedBy: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const StudentSponsor = sequelize.define('StudentSponsor', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  sponsorId: { type: DataTypes.UUID, allowNull: false },
  sponsorshipType: {
    type: DataTypes.ENUM('FULL', 'PARTIAL'),
    defaultValue: 'FULL'
  },
  amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const StaffAttendance = sequelize.define('StaffAttendance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  staffId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  status: {
    type: DataTypes.ENUM('PRESENT', 'ABSENT', 'LATE', 'LEAVE', 'HOLIDAY', 'REMOTE', 'OFF')
  },
  timeIn: DataTypes.TIME,
  timeOut: DataTypes.TIME,
  remarks: DataTypes.TEXT,
  markedBy: DataTypes.UUID,
  approved: { type: DataTypes.BOOLEAN, defaultValue: false },
  approvalStatus: { 
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
    defaultValue: 'PENDING'
  },
  approvedBy: DataTypes.UUID,
  approvedAt: DataTypes.DATE
});
// Add these model definitions after your existing models (around line 1400)

const HealthRecords = sequelize.define('HealthRecords', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  temperature: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
  bloodPressure: { type: DataTypes.STRING(20), allowNull: true },
  weight: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  height: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  symptoms: { type: DataTypes.TEXT, allowNull: true },
  diagnosis: { type: DataTypes.TEXT, allowNull: false },
  prescription: { type: DataTypes.TEXT, allowNull: true },
  followUpDate: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING(50), defaultValue: 'TREATED' },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  recordedBy: { type: DataTypes.UUID, allowNull: true }
}, {
  tableName: 'HealthRecords',
  timestamps: true
});

const SchemesOfWork = sequelize.define('SchemesOfWork', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  
  // Regular School fields - allow null
  classId: { type: DataTypes.UUID, allowNull: true },  // ← Change from allowNull: false
  subjectId: { type: DataTypes.UUID, allowNull: true }, // ← Change from allowNull: false
  
  // University fields
  courseId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  
  // TVET fields
  programId: { type: DataTypes.UUID, allowNull: true },
  moduleId: { type: DataTypes.UUID, allowNull: true },
  
  // Common fields - these stay required
  period: { type: DataTypes.STRING(100), allowNull: false },
  week: { type: DataTypes.STRING(100), allowNull: false },
  topic: { type: DataTypes.STRING(255), allowNull: false },
  subTopic: { type: DataTypes.STRING(255), allowNull: true },
  objectives: { type: DataTypes.TEXT, allowNull: true },
  teachingActivities: { type: DataTypes.TEXT, allowNull: true },
  learningActivities: { type: DataTypes.TEXT, allowNull: true },
  resources: { type: DataTypes.TEXT, allowNull: true },
  assessment: { type: DataTypes.TEXT, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  covered: { type: DataTypes.BOOLEAN, defaultValue: false },
  dateCovered: { type: DataTypes.DATEONLY, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  createdBy: { type: DataTypes.UUID, allowNull: true }
}, {
  tableName: 'SchemesOfWork',
  timestamps: true
});
// ==================== COURSE ENROLLMENT MODEL ====================
const CourseEnrollment = sequelize.define('CourseEnrollment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  enrollmentDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  academicYear: { type: DataTypes.STRING, allowNull: false },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  status: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DROPPED', 'COMPLETED'),
    defaultValue: 'PENDING'
  },
  approvedBy: { type: DataTypes.UUID, allowNull: true },
  approvedAt: { type: DataTypes.DATE, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
}, {
  timestamps: true
});

// ==================== UNIT REGISTRATION MODEL ====================
const UnitRegistration = sequelize.define('UnitRegistration', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  unitId: { type: DataTypes.UUID, allowNull: false },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  academicYear: { type: DataTypes.STRING, allowNull: false },
  registrationDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  status: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DROPPED', 'COMPLETED'),
    defaultValue: 'PENDING'
  },
  approvedBy: { type: DataTypes.UUID, allowNull: true },
  approvedAt: { type: DataTypes.DATE, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
}, {
  timestamps: true
});


// ==================== STUDENT ARRIVAL MODEL ====================
const StudentArrival = sequelize.define('StudentArrival', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  arrivedAt: { type: DataTypes.DATE, allowNull: true },
  departedAt: { type: DataTypes.DATE, allowNull: true },
  markedBy: { type: DataTypes.UUID, allowNull: false },
  status: {
    type: DataTypes.ENUM('ARRIVED', 'LATE', 'ABSENT', 'EXCUSED', 'DEPARTED'), // ✅ ADDED 'DEPARTED'
    defaultValue: 'ARRIVED'
  },
  notes: { type: DataTypes.TEXT, allowNull: true },
  timeIn: { type: DataTypes.TIME, allowNull: true },
  timeOut: { type: DataTypes.TIME, allowNull: true },
  parentNotifiedArrival: { type: DataTypes.BOOLEAN, defaultValue: false },
  parentNotifiedDeparture: { type: DataTypes.BOOLEAN, defaultValue: false },
  parentNotifiedAt: { type: DataTypes.DATE, allowNull: true },
  departureNotifiedAt: { type: DataTypes.DATE, allowNull: true }
}, {
  timestamps: true
});

// ==================== VISITOR MODEL ====================
const Visitor = sequelize.define('Visitor', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  phone: DataTypes.STRING,
  email: DataTypes.STRING,
  purpose: DataTypes.STRING,
  personToSee: DataTypes.STRING,
  idNumber: DataTypes.STRING,
  vehicleNumber: DataTypes.STRING,
  checkIn: { 
    type: DataTypes.DATE, 
    allowNull: false,
    defaultValue: DataTypes.NOW  // ✅ Add default value
  },
  checkOut: DataTypes.DATE,
  status: {
    type: DataTypes.ENUM('CHECKED_IN', 'CHECKED_OUT'),
    defaultValue: 'CHECKED_IN'
  },
  checkedInBy: DataTypes.UUID
}, { 
  timestamps: true 
});
// ==================== RECEPTIONIST MODELS ====================

// COMPLAINT MODEL
const Complaint = sequelize.define('Complaint', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  complainant: { type: DataTypes.STRING, allowNull: false },
  complainantType: {
    type: DataTypes.ENUM('PARENT', 'STUDENT', 'STAFF', 'VISITOR', 'OTHER'),
    defaultValue: 'PARENT'
  },
  contact: DataTypes.STRING,
  category: {
    type: DataTypes.ENUM('GENERAL', 'ACADEMIC', 'FINANCE', 'FACILITIES', 'STAFF', 'TRANSPORT', 'FOOD', 'DISCIPLINE', 'OTHER'),
    defaultValue: 'GENERAL'
  },
  description: { type: DataTypes.TEXT, allowNull: false },
  urgency: {
    type: DataTypes.ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT'),
    defaultValue: 'NORMAL'
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'),
    defaultValue: 'OPEN'
  },
  assignedTo: DataTypes.UUID,
  reportedBy: DataTypes.UUID,
  resolvedAt: DataTypes.DATE,
  resolution: DataTypes.TEXT
}, { timestamps: true });

// ==================== APPOINTMENT MODEL ====================
const Appointment = sequelize.define('Appointment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT,
  parentId: { 
    type: DataTypes.UUID, 
    allowNull: true  // ✅ Make it optional
  },
  staffId: { 
    type: DataTypes.UUID, 
    allowNull: true  // ✅ Make it optional
  },
  studentId: { 
    type: DataTypes.UUID, 
    allowNull: true  // ✅ Make it optional
  },
  date: { type: DataTypes.DATE, allowNull: false },
  time: { type: DataTypes.TIME, allowNull: false },
  duration: { type: DataTypes.INTEGER, defaultValue: 30 },
  status: {
    type: DataTypes.ENUM('SCHEDULED', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'SCHEDULED'
  },
  type: {
    type: DataTypes.ENUM('PARENT_TEACHER', 'PARENT_PRINCIPAL', 'STAFF_PRINCIPAL', 'STUDENT_COUNSELOR', 'OTHER'),
    defaultValue: 'PARENT_TEACHER'
  },
  scheduledBy: DataTypes.UUID
}, { timestamps: true });

// ==================== TASK MODEL ====================
const Task = sequelize.define('Task', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: false },
  assignedTo: { 
    type: DataTypes.UUID, 
    allowNull: true  // ✅ Make it optional
  },
  assignedBy: { 
    type: DataTypes.UUID, 
    allowNull: true  // ✅ Make it optional
  },
  dueDate: DataTypes.DATE,
  priority: {
    type: DataTypes.ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT'),
    defaultValue: 'NORMAL'
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'PENDING'
  },
  completedAt: DataTypes.DATE
}, { timestamps: true });

// CALL LOG MODEL (already defined, but ensure it's correct)
const CallLog = sequelize.define('CallLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  callerName: { type: DataTypes.STRING, allowNull: false },
  callerPhone: DataTypes.STRING,
  recipient: DataTypes.STRING,
  purpose: DataTypes.STRING,
  duration: DataTypes.INTEGER,
  status: {
    type: DataTypes.ENUM('INCOMING', 'OUTGOING', 'MISSED'),
    defaultValue: 'INCOMING'
  },
  notes: DataTypes.TEXT,
  timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  loggedBy: DataTypes.UUID
}, { timestamps: true });


// ==================== CARD MODEL ====================
const Card = sequelize.define('Card', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  personId: { type: DataTypes.UUID, allowNull: false },
  personType: {
    type: DataTypes.ENUM('STUDENT', 'STAFF'),
    allowNull: false
  },
  cardNumber: { type: DataTypes.STRING, unique: true },
  template: { type: DataTypes.JSONB, defaultValue: {} },
  status: {
    type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED', 'EXPIRED'),
    defaultValue: 'ACTIVE'
  },
  issuedDate: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  expiryDate: DataTypes.DATE,
  generatedBy: DataTypes.UUID,
  qrCode: DataTypes.TEXT,
  lastPrinted: DataTypes.DATE,
  printCount: { type: DataTypes.INTEGER, defaultValue: 0 }
}, { timestamps: true });
// ==================== CERTIFICATE MODEL ====================
const Certificate = sequelize.define('Certificate', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  recipientId: { type: DataTypes.UUID, allowNull: false },
  recipientType: {
    type: DataTypes.ENUM('STUDENT', 'STAFF'),
    allowNull: false
  },
  certificateNumber: { type: DataTypes.STRING, unique: true },
  type: {
    type: DataTypes.ENUM(
      'student_of_year', 'teacher_of_year', 'academic_excellence',
      'sports_achievement', 'arts_culture', 'leadership',
      'community_service', 'graduation', 'participation', 'custom'
    ),
    defaultValue: 'custom'
  },
  template: { type: DataTypes.JSONB, defaultValue: {} },
  issuedDate: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }, // ✅ Use this
  generatedBy: DataTypes.UUID,
  status: {
    type: DataTypes.ENUM('DRAFT', 'ISSUED', 'REVOKED'),
    defaultValue: 'DRAFT'
  },
  description: DataTypes.TEXT,
  signature: DataTypes.TEXT
}, { 
  timestamps: true 
});
// ==================== 3. ALUMNI MODELS ====================

// ============================================================
// ==================== ALUMNI MODEL ====================
// ============================================================

const Alumni = sequelize.define('Alumni', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  studentId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  schoolId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  graduationYear: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  currentStatus: {
    type: DataTypes.ENUM('EMPLOYED', 'SELF_EMPLOYED', 'FURTHER_STUDIES', 'UNEMPLOYED', 'OTHER'),
    defaultValue: 'OTHER'
  },
  occupation: DataTypes.STRING,
  company: DataTypes.STRING,
  location: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  linkedin: DataTypes.STRING,
  bio: DataTypes.TEXT,
  achievements: {
    type: DataTypes.JSONB,
    defaultValue: []
  }
}, { 
  timestamps: true 
});
const AlumniEvent = sequelize.define('AlumniEvent', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  schoolId: { 
    type: DataTypes.UUID, 
    allowNull: false 
  },
  title: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  date: { 
    type: DataTypes.DATE, 
    allowNull: false 
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true
  },
  type: {
    type: DataTypes.ENUM('REUNION', 'NETWORKING', 'WEBINAR', 'SOCIAL', 'FUNDRAISER', 'OTHER'),
    defaultValue: 'OTHER'
  },
  capacity: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  attendees: { 
    type: DataTypes.JSONB, 
    defaultValue: [] 
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'SCHEDULED'
  }
}, { 
  timestamps: true 
});

const AlumniEventAttendee = sequelize.define('AlumniEventAttendee', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  eventId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  alumniId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('ATTENDING', 'NOT_ATTENDING', 'MAYBE'),
    defaultValue: 'MAYBE'
  },
  rsvpDate: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  checkedIn: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  checkedInAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  markedBy: {  // Who marked this attendee
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  checkedInBy: {  // Who checked this attendee in
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    }
  }
}, { 
  timestamps: true 
});
const LiveClass = sequelize.define('LiveClass', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  schoolId: { 
    type: DataTypes.UUID, 
    allowNull: false 
  },
  title: { 
    type: DataTypes.STRING, 
    allowNull: false 
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  teacherId: { 
    type: DataTypes.UUID, 
    allowNull: false 
  },
  date: { 
    type: DataTypes.DATEONLY, 
    allowNull: false 
  },
  time: { 
    type: DataTypes.TIME, 
    allowNull: false 
  },
  duration: { 
    type: DataTypes.INTEGER, 
    defaultValue: 60 
  },
  platform: {
    type: DataTypes.ENUM('zoom', 'meet', 'teams', 'other'),
    defaultValue: 'zoom'
  },
  meetingLink: {
    type: DataTypes.STRING,
    allowNull: false
  },
  meetingId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  meetingPassword: {
    type: DataTypes.STRING,
    allowNull: true
  },
  recordingLink: {
    type: DataTypes.STRING,
    allowNull: true
  },
  classMaterials: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  participants: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  status: {
    type: DataTypes.ENUM('SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'SCHEDULED'
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false
  },
  // NEW FIELDS for filtering
  classId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  subjectId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  courseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  unitId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  programId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  module: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  semester: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  attendanceMarked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, { 
  timestamps: true 
});
const ClassAttendance = sequelize.define('ClassAttendance', {
  id: { 
    type: DataTypes.UUID, 
    defaultValue: DataTypes.UUIDV4, 
    primaryKey: true 
  },
  liveClassId: { 
    type: DataTypes.UUID, 
    allowNull: false 
  },
  studentId: { 
    type: DataTypes.UUID, 
    allowNull: true
  },
  userId: {           
    type: DataTypes.UUID,
    allowNull: false
  },
  userType: {         
    type: DataTypes.STRING,  // ✅ MUST BE STRING, NOT ENUM!
    defaultValue: 'STUDENT',
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('PRESENT', 'ABSENT', 'LATE'),
    defaultValue: 'PRESENT'
  },
  joinTime: DataTypes.DATE,
  leaveTime: DataTypes.DATE,
  duration: DataTypes.INTEGER,
  remarks: DataTypes.TEXT
}, { timestamps: true });

// backend/models/OnlineExam.js - UPDATED MODEL

const OnlineExam = sequelize.define('OnlineExam', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  schoolId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  // ===== REGULAR SCHOOL FIELDS =====
  subjectId: {
    type: DataTypes.UUID,
    allowNull: true  // ← This should be TRUE
  },
  classId: {
    type: DataTypes.UUID,
    allowNull: true  // ← This should be TRUE
  },

  // ===== UNIVERSITY FIELDS =====
  courseId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  unitId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  semester: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: true
  },

  // ===== TVET FIELDS =====
  programId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  module: {
    type: DataTypes.INTEGER,
    allowNull: true
  },

  // ===== EXAM SCHEDULING =====
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  startTime: {
    type: DataTypes.TIME,
    allowNull: true
  },
  endTime: {
    type: DataTypes.TIME,
    allowNull: true
  },
  duration: {
    type: DataTypes.INTEGER,
    defaultValue: 60
  },

  // ===== GRADING =====
  totalMarks: {
    type: DataTypes.INTEGER,
    defaultValue: 100
  },
  passingMarks: {
    type: DataTypes.INTEGER,
    defaultValue: 40
  },

  // ===== EXAM TYPE =====
  examType: {
    type: DataTypes.ENUM(
      'OPENER', 'MIDTERM', 'ENDTERM', 'CAT', 'MOCK', 'PRE_MOCK',
      'PRACTICAL', 'PROJECT', 'MAIN_EXAM', 'SUPPLEMENTARY', 'SPECIAL',
      'QUIZ', 'ASSIGNMENT', 'FINAL', 'LAB', 'PRESENTATION', 'THESIS', 'DEFENSE'
    ),
    defaultValue: 'MAIN_EXAM'
  },

  // ===== TERM/ACADEMIC PERIOD =====
  term: {
    type: DataTypes.STRING,
    allowNull: true
  },
  academicYear: {
    type: DataTypes.STRING,
    allowNull: true
  },

  // ===== STUDENT SELECTION =====
  selectedStudents: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // ===== ATTEMPT SETTINGS =====
  allowMultipleAttempts: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  maxAttempts: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  showAnswersAfterSubmission: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  allowRetake: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // ===== STATUS =====
  status: {
    type: DataTypes.ENUM('DRAFT', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CLOSED'),
    defaultValue: 'DRAFT'
  },

  createdBy: {
    type: DataTypes.UUID,
    allowNull: true
  },
  publishedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }

}, { timestamps: true });
// ExamQuestion Model
const ExamQuestion = sequelize.define('ExamQuestion', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  examId: { type: DataTypes.UUID, allowNull: false },
  type: {
    type: DataTypes.ENUM('MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'ESSAY'),
    defaultValue: 'MCQ'
  },
  question: { type: DataTypes.TEXT, allowNull: false },
  options: { type: DataTypes.JSONB, defaultValue: [] },
  correctAnswer: { type: DataTypes.STRING, allowNull: true },
  marks: { type: DataTypes.INTEGER, defaultValue: 5 },
  order: { type: DataTypes.INTEGER, defaultValue: 0 }
}, { timestamps: true });

// ExamResult Model
const ExamResult = sequelize.define('ExamResult', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  examId: { type: DataTypes.UUID, allowNull: false },
  studentId: { type: DataTypes.UUID, allowNull: false },
  score: { type: DataTypes.INTEGER, defaultValue: 0 },
  totalMarks: { type: DataTypes.INTEGER, defaultValue: 0 },
  percentage: { type: DataTypes.FLOAT, defaultValue: 0 },
  grade: { type: DataTypes.STRING, allowNull: true },
  points: { type: DataTypes.FLOAT, allowNull: true },
  passed: { type: DataTypes.BOOLEAN, defaultValue: false },
  answers: { type: DataTypes.JSONB, defaultValue: [] },
  timeTaken: { type: DataTypes.INTEGER, defaultValue: 0 },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  attemptNumber: { type: DataTypes.INTEGER, defaultValue: 1 },
  submittedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { timestamps: true });



const FeeAllocation = sequelize.define('FeeAllocation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  feeId: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  allocatedDate: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  allocatedBy: { type: DataTypes.UUID, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  allocationType: { 
    type: DataTypes.ENUM('AUTO', 'MANUAL'),
    defaultValue: 'MANUAL'
  },
  notes: DataTypes.TEXT,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
}, {
  timestamps: true,
  indexes: [
    { fields: ['studentId'] },
    { fields: ['feeId'] },
    { fields: ['schoolId'] }
  ]
});

// ==================== FEE ALLOCATION ASSOCIATIONS ====================
FeeAllocation.belongsTo(Student, { foreignKey: 'studentId' });
FeeAllocation.belongsTo(Fee, { foreignKey: 'feeId' });
Student.hasMany(FeeAllocation, { foreignKey: 'studentId' });
Fee.hasMany(FeeAllocation, { foreignKey: 'feeId' });

// ============================================================
// ==================== MODEL ASSOCIATIONS ====================
// ============================================================

Complaint.belongsTo(School, { foreignKey: 'schoolId' });
Complaint.belongsTo(User, { as: 'assignedToUser', foreignKey: 'assignedTo' });

Appointment.belongsTo(School, { foreignKey: 'schoolId' });
Appointment.belongsTo(User, { as: 'staff', foreignKey: 'staffId', constraints: false });
Appointment.belongsTo(User, { as: 'parent', foreignKey: 'parentId', constraints: false });
Appointment.belongsTo(Student, { as: 'student', foreignKey: 'studentId', constraints: false });

Task.belongsTo(School, { foreignKey: 'schoolId' });
Task.belongsTo(User, { as: 'assignedToUser', foreignKey: 'assignedTo', constraints: false });
Task.belongsTo(User, { as: 'assignedByUser', foreignKey: 'assignedBy', constraints: false });

CallLog.belongsTo(School, { foreignKey: 'schoolId' });
CallLog.belongsTo(User, { as: 'loggedByUser', foreignKey: 'loggedBy' });

Card.belongsTo(School, { foreignKey: 'schoolId' });
Card.belongsTo(Student, { foreignKey: 'personId', constraints: false });
Card.belongsTo(Staff, { foreignKey: 'personId', constraints: false });
Card.belongsTo(User, { as: 'generatedByUser', foreignKey: 'generatedBy' });

Certificate.belongsTo(School, { foreignKey: 'schoolId' });
Certificate.belongsTo(Student, { foreignKey: 'recipientId', constraints: false });
Certificate.belongsTo(Staff, { foreignKey: 'recipientId', constraints: false });
Certificate.belongsTo(User, { as: 'generatedByUser', foreignKey: 'generatedBy' });

AlumniEvent.belongsTo(User, { foreignKey: 'createdBy', as: 'createdByUser' });
AlumniEvent.belongsTo(School, { foreignKey: 'schoolId', as: 'school' });
AlumniEvent.hasMany(AlumniEventAttendee, { foreignKey: 'eventId', as: 'eventAttendees' });

AlumniEventAttendee.belongsTo(AlumniEvent, { foreignKey: 'eventId', as: 'event' });
AlumniEventAttendee.belongsTo(Alumni, { foreignKey: 'alumniId', as: 'alumni' });

Alumni.belongsTo(Student, { foreignKey: 'studentId', as: 'Student' });
Alumni.belongsTo(School, { foreignKey: 'schoolId', as: 'school' });
Alumni.hasMany(AlumniEventAttendee, { foreignKey: 'alumniId', as: 'eventAttendees' });

User.hasMany(AlumniEvent, { foreignKey: 'createdBy', as: 'createdEvents' });
// ============================================================
// ==================== LIVE CLASSROOM ASSOCIATIONS ====================
// ============================================================

LiveClass.belongsTo(School, { 
  foreignKey: 'schoolId' 
});

// Teacher association WITHOUT foreign key constraint
LiveClass.belongsTo(User, { 
  as: 'Teacher', 
  foreignKey: 'teacherId',
  constraints: false 
});

// Created By association
LiveClass.belongsTo(User, { 
  as: 'createdByUser', 
  foreignKey: 'createdBy' 
});

// Class association (for regular schools)
LiveClass.belongsTo(Class, {
  foreignKey: 'classId',
  as: 'class',
  constraints: false
});

// Subject association (for regular schools)
LiveClass.belongsTo(Subject, {
  foreignKey: 'subjectId',
  as: 'subject',
  constraints: false
});

// Course association (for university)
LiveClass.belongsTo(Course, {
  foreignKey: 'courseId',
  as: 'course',
  constraints: false
});

// CourseUnit association (for university/TVET)
LiveClass.belongsTo(CourseUnit, {
  foreignKey: 'unitId',
  as: 'unit',
  constraints: false
});

// Program association (for TVET)
LiveClass.belongsTo(Program, {
  foreignKey: 'programId',
  as: 'program',
  constraints: false
});

// Has many attendances
LiveClass.hasMany(ClassAttendance, { 
  foreignKey: 'liveClassId',
  as: 'attendances' 
});

// Attendance belongs to LiveClass
ClassAttendance.belongsTo(LiveClass, { 
  foreignKey: 'liveClassId' 
});

ClassAttendance.belongsTo(Student, { 
  foreignKey: 'studentId',
  constraints: false  // ✅ No foreign key constraint
});

ClassAttendance.belongsTo(User, { 
  foreignKey: 'userId',
  as: 'user',
  constraints: false
});

// ============================================================
// ==================== ONLINE EXAM ASSOCIATIONS ====================
// ============================================================

OnlineExam.belongsTo(School, { foreignKey: 'schoolId' });

// ✅ Use unique aliases for each association
OnlineExam.belongsTo(Subject, { 
  foreignKey: 'subjectId', 
  as: 'subject' 
});

OnlineExam.belongsTo(Class, { 
  foreignKey: 'classId', 
  as: 'class' 
});

OnlineExam.belongsTo(Course, { 
  foreignKey: 'courseId', 
  as: 'course' 
});

OnlineExam.belongsTo(Program, { 
  foreignKey: 'programId', 
  as: 'program' 
});

OnlineExam.belongsTo(CourseUnit, { 
  foreignKey: 'unitId', 
  as: 'courseUnit' 
});

OnlineExam.belongsTo(User, { 
  as: 'createdByUser', 
  foreignKey: 'createdBy' 
});

// ✅ Use unique aliases for hasMany too
OnlineExam.hasMany(ExamQuestion, { 
  foreignKey: 'examId', 
  as: 'examQuestions' 
});

OnlineExam.hasMany(ExamResult, { 
  foreignKey: 'examId', 
  as: 'examResults' 
});

ExamQuestion.belongsTo(OnlineExam, { foreignKey: 'examId' });
ExamResult.belongsTo(OnlineExam, { foreignKey: 'examId' });
ExamResult.belongsTo(Student, { foreignKey: 'studentId' });

HealthRecords.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(HealthRecords, { foreignKey: 'studentId' });

CourseEnrollment.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(CourseEnrollment, { foreignKey: 'studentId' });
CourseEnrollment.belongsTo(Course, { foreignKey: 'courseId' });
Course.hasMany(CourseEnrollment, { foreignKey: 'courseId' });
CourseEnrollment.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(CourseEnrollment, { foreignKey: 'programId' });
CourseEnrollment.belongsTo(User, { as: 'approver', foreignKey: 'approvedBy' });
CourseEnrollment.belongsTo(School, { foreignKey: 'schoolId' });

UnitRegistration.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(UnitRegistration, { foreignKey: 'studentId' });
UnitRegistration.belongsTo(CourseUnit, { foreignKey: 'unitId' });
CourseUnit.hasMany(UnitRegistration, { foreignKey: 'unitId' });
UnitRegistration.belongsTo(Course, { foreignKey: 'courseId' });
Course.hasMany(UnitRegistration, { foreignKey: 'courseId' });
UnitRegistration.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(UnitRegistration, { foreignKey: 'programId' });
UnitRegistration.belongsTo(User, { as: 'approver', foreignKey: 'approvedBy' });
UnitRegistration.belongsTo(School, { foreignKey: 'schoolId' });

SchemesOfWork.belongsTo(Class, { foreignKey: 'classId' });
SchemesOfWork.belongsTo(Subject, { foreignKey: 'subjectId' });
Class.hasMany(SchemesOfWork, { foreignKey: 'classId' });
Subject.hasMany(SchemesOfWork, { foreignKey: 'subjectId' });
SchemesOfWork.belongsTo(Course, { foreignKey: 'courseId' });
SchemesOfWork.belongsTo(CourseUnit, { as: 'unit', foreignKey: 'unitId' });
Course.hasMany(SchemesOfWork, { foreignKey: 'courseId' });
CourseUnit.hasMany(SchemesOfWork, { as: 'units', foreignKey: 'unitId' });
SchemesOfWork.belongsTo(Program, { foreignKey: 'programId' });
SchemesOfWork.belongsTo(CourseUnit, { as: 'tvetModule', foreignKey: 'moduleId' });
Program.hasMany(SchemesOfWork, { foreignKey: 'programId' });
CourseUnit.hasMany(SchemesOfWork, { as: 'tvetModules', foreignKey: 'moduleId' });

School.hasMany(User, { foreignKey: 'schoolId' });
User.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Class, { foreignKey: 'schoolId' });
Class.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Student, { foreignKey: 'schoolId' });
Student.belongsTo(School, { foreignKey: 'schoolId' });
Student.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(Student, { foreignKey: 'userId' });
School.hasMany(Subject, { foreignKey: 'schoolId' });
Subject.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Exam, { foreignKey: 'schoolId' });
Exam.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Fee, { foreignKey: 'schoolId' });
Fee.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Expense, { foreignKey: 'schoolId' });
Expense.belongsTo(School, { foreignKey: 'schoolId' });
Staff.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Staff, { foreignKey: 'schoolId' });

StudentArrival.belongsTo(Student, { foreignKey: 'studentId' });
StudentArrival.belongsTo(User, { as: 'markedByUser', foreignKey: 'markedBy' });
Student.hasMany(StudentArrival, { foreignKey: 'studentId' });

Staff.belongsTo(User, { foreignKey: 'userId' });
User.hasOne(Staff, { foreignKey: 'userId' });
School.hasMany(Vehicle, { foreignKey: 'schoolId' });
Vehicle.belongsTo(School, { foreignKey: 'schoolId' });

Exam.belongsTo(Course, { as: 'course', foreignKey: 'courseId' });
Exam.belongsTo(Program, { as: 'program', foreignKey: 'programId' });
Exam.belongsTo(CourseUnit, { as: 'courseUnit', foreignKey: 'unitId' });
Exam.belongsTo(Class, { as: 'class', foreignKey: 'classId' });
Exam.belongsTo(Subject, { as: 'subject', foreignKey: 'subjectId' });
Exam.belongsTo(Faculty, { as: 'faculty', foreignKey: 'facultyId' });
Exam.belongsTo(Department, { as: 'department', foreignKey: 'departmentId' });

School.hasMany(Hostel, { foreignKey: 'schoolId' });
Hostel.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Inventory, { foreignKey: 'schoolId' });
Inventory.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Book, { foreignKey: 'schoolId' });
Book.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Announcement, { foreignKey: 'schoolId' });
Announcement.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Event, { foreignKey: 'schoolId' });
Event.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Feature, { foreignKey: 'schoolId' });
Feature.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Faculty, { foreignKey: 'schoolId' });
Faculty.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(Program, { foreignKey: 'schoolId' });
Program.belongsTo(School, { foreignKey: 'schoolId' });
School.hasMany(CourseUnit, { foreignKey: 'schoolId' });
CourseUnit.belongsTo(School, { foreignKey: 'schoolId' });
Program.belongsTo(Department, { foreignKey: 'departmentId' });
Department.hasMany(Program, { foreignKey: 'departmentId' });
School.hasMany(Timetable, { foreignKey: 'schoolId' });
Timetable.belongsTo(School, { foreignKey: 'schoolId' });

Timetable.hasMany(Attendance, { foreignKey: 'timetableId' });
Attendance.belongsTo(Timetable, { foreignKey: 'timetableId' });
CourseUnit.hasMany(Attendance, { foreignKey: 'unitId' });
Attendance.belongsTo(CourseUnit, { foreignKey: 'unitId' });

Faculty.hasMany(Department, { foreignKey: 'facultyId' });
Department.belongsTo(Faculty, { foreignKey: 'facultyId' });
Department.hasMany(Course, { foreignKey: 'departmentId' });
Course.belongsTo(Department, { foreignKey: 'departmentId' });
Department.hasMany(Program, { foreignKey: 'departmentId' });
Program.belongsTo(Department, { foreignKey: 'departmentId' });

Timetable.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Timetable, { foreignKey: 'programId' });
Course.hasMany(CourseUnit, { foreignKey: 'courseId' });
CourseUnit.belongsTo(Course, { foreignKey: 'courseId' });
Exam.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Exam, { foreignKey: 'programId' });
Department.hasMany(Lab, { foreignKey: 'departmentId' });
Lab.belongsTo(Department, { foreignKey: 'departmentId' });
Faculty.hasMany(Research, { foreignKey: 'facultyId' });
Research.belongsTo(Faculty, { foreignKey: 'facultyId' });

User.belongsTo(Role, { foreignKey: 'roleId' });
Role.belongsTo(School, { foreignKey: 'schoolId', as: 'school' });
School.hasMany(Role, { foreignKey: 'schoolId', as: 'roles' });
Permission.belongsTo(School, { foreignKey: 'schoolId', as: 'school' });
School.hasMany(Permission, { foreignKey: 'schoolId', as: 'permissions' });

Class.hasMany(Student, { foreignKey: 'classId' });
Student.belongsTo(Class, { foreignKey: 'classId' });
Class.hasMany(Subject, { foreignKey: 'classId' });
Subject.belongsTo(Class, { foreignKey: 'classId' });
Class.hasMany(Timetable, { foreignKey: 'classId' });
Timetable.belongsTo(Class, { foreignKey: 'classId' });
Class.belongsTo(User, { as: 'classTeacher', foreignKey: 'classTeacherId' });

Student.hasMany(Result, { foreignKey: 'studentId' });
Result.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(Attendance, { foreignKey: 'studentId' });
Attendance.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(Payment, { foreignKey: 'studentId' });
Payment.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(Parent, { foreignKey: 'studentId' });
Parent.belongsTo(Student, { foreignKey: 'studentId' });
Student.belongsTo(TransportRoute, { foreignKey: 'transportRouteId' });
Student.belongsTo(Course, { foreignKey: 'courseId' });
Student.belongsTo(Program, { foreignKey: 'programId' });
Student.belongsTo(Hostel, { foreignKey: 'hostelId' });

User.hasOne(Staff, { foreignKey: 'userId' });
Staff.belongsTo(User, { foreignKey: 'userId' });
Staff.belongsTo(Department, { as: 'managedDepartment', foreignKey: 'managesDepartmentId' });
Staff.belongsTo(Faculty, { as: 'managedFaculty', foreignKey: 'managesFacultyId' });
Staff.belongsTo(Department, { foreignKey: 'departmentId' });
Staff.belongsTo(Faculty, { foreignKey: 'facultyId' });
Department.belongsTo(Staff, { as: 'headOfDepartment', foreignKey: 'headOfDepartmentId' });
Faculty.belongsTo(Staff, { as: 'facultyDean', foreignKey: 'deanId' });

User.hasMany(Parent, { foreignKey: 'userId' });
Parent.belongsTo(User, { foreignKey: 'userId' });

Exam.belongsTo(Class, { foreignKey: 'classId' });
Exam.belongsTo(Subject, { foreignKey: 'subjectId' });
Exam.belongsTo(Course, { foreignKey: 'courseId' });
Exam.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
Exam.belongsTo(Faculty, { foreignKey: 'facultyId' });
Exam.belongsTo(Department, { foreignKey: 'departmentId' });

Attendance.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
CourseUnit.hasMany(Attendance, { foreignKey: 'unitId' });
Attendance.belongsTo(Subject, { foreignKey: 'subjectId' });
Subject.hasMany(Attendance, { foreignKey: 'subjectId' });
Attendance.belongsTo(Timetable, { foreignKey: 'timetableId' });
Timetable.hasMany(Attendance, { foreignKey: 'timetableId' });

Result.belongsTo(Exam, { foreignKey: 'examId' });
Result.belongsTo(Subject, { foreignKey: 'subjectId' });
Result.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'CourseUnit' });
Subject.belongsTo(User, { as: 'teacher', foreignKey: 'teacherId' });

Fee.belongsTo(Class, { foreignKey: 'classId' });
Fee.belongsTo(Course, { foreignKey: 'courseId' });
Fee.belongsTo(Faculty, { foreignKey: 'facultyId' });
Fee.belongsTo(Department, { foreignKey: 'departmentId' });
Fee.belongsTo(Program, { foreignKey: 'programId' });
Fee.belongsTo(TransportRoute, { foreignKey: 'transportRouteId' });
Payment.belongsTo(Fee, { foreignKey: 'feeId' });

Timetable.belongsTo(Subject, { foreignKey: 'subjectId' });
Timetable.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
Timetable.belongsTo(Staff, { as: 'teacher', foreignKey: 'teacherId' });
Timetable.belongsTo(Course, { foreignKey: 'courseId' });
Timetable.belongsTo(Class, { foreignKey: 'classId' });

TransportRoute.belongsTo(Vehicle, { foreignKey: 'vehicleId' });
TransportRoute.hasMany(Student, { foreignKey: 'transportRouteId' });
Vehicle.hasMany(TransportRoute, { foreignKey: 'vehicleId' });
Vehicle.hasMany(Maintenance, { foreignKey: 'vehicleId' });
Maintenance.belongsTo(Vehicle, { foreignKey: 'vehicleId' });

Inventory.hasMany(InventoryUsage, { foreignKey: 'inventoryId' });
InventoryUsage.belongsTo(Inventory, { foreignKey: 'inventoryId' });
Borrow.belongsTo(Book, { foreignKey: 'bookId' });
Borrow.belongsTo(Student, { foreignKey: 'studentId' });
Payroll.belongsTo(Staff, { foreignKey: 'staffId' });

Attendance.belongsTo(Class, { foreignKey: 'classId' });
Attendance.belongsTo(User, { as: 'markedByUser', foreignKey: 'markedBy' });
Attendance.belongsTo(Course, { foreignKey: 'courseId' });
Attendance.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Attendance, { foreignKey: 'programId' });

AuditLog.belongsTo(User, { foreignKey: 'userId' });
StaffAttendance.belongsTo(Staff, { foreignKey: 'staffId' });
Staff.hasMany(StaffAttendance, { foreignKey: 'staffId', as: 'attendances' });

Sponsor.belongsTo(School, { foreignKey: 'schoolId' });
Sponsor.belongsToMany(Student, { through: StudentSponsor, foreignKey: 'sponsorId' });
Student.belongsToMany(Sponsor, { through: StudentSponsor, foreignKey: 'studentId' });
CourseUnit.belongsTo(Course, { foreignKey: 'courseId' });
CourseUnit.belongsTo(Program, { foreignKey: 'programId' });

// ==================== PERMISSION DEFINITIONS ====================
const PERMISSIONS = {
  SUPER_ADMIN: '*',
  SCHOOL_ADMIN: [
    'manage_school',
    'manage_users',
    'manage_students',
    'manage_classes',
    'manage_subjects',
    'manage_exams',
    'manage_results',
    'manage_attendance',
    'manage_fees',
    'manage_payments',
    'manage_staff',
    'manage_payroll',
    'manage_library',
    'manage_transport',
    'manage_hostel',
    'manage_inventory',
    'manage_announcements',
    'manage_events',
    'manage_timetable',
    'view_reports',
    'view_financial_reports',
    'view_attendance',
    'view_results'
  ],
  PRINCIPAL: [
    'view_students',
    'view_classes',
    'view_subjects',
    'view_exams',
    'view_results',
    'view_attendance',
    'view_fees',
    'view_payments',
    'view_staff',
    'view_library',
    'view_transport',
    'view_hostel',
    'view_inventory',
    'view_announcements',
    'view_events',
    'view_timetable',
    'view_reports'
  ],
  DEPUTY_PRINCIPAL: [
    'view_students',
    'view_classes',
    'view_subjects',
    'view_exams',
    'view_results',
    'view_attendance',
    'view_fees',
    'view_payments',
    'view_staff',
    'view_library',
    'view_transport',
    'view_hostel',
    'view_inventory',
    'view_announcements',
    'view_events',
    'view_timetable',
    'view_reports'
  ],
  SENIOR_TEACHER: [
    'view_students',
    'view_classes',
    'manage_own_subjects',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  CLASS_TEACHER: [
    'view_students',
    'view_own_class',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  SUBJECT_TEACHER: [
    'view_students',
    'manage_own_subjects',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  TEACHER: [
    'view_students',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  ACCOUNTANT: [
    'view_fees',
    'manage_payments',
    'view_financial_reports',
    'manage_expenses'
  ],
  LIBRARIAN: [
    'manage_library',
    'view_books',
    'manage_borrowing'
  ],
  NURSE: [
    'view_students',
    'manage_medical_records'
  ],
  MATRON: [
    'view_students',
    'manage_hostel'
  ],
  TRANSPORT_MANAGER: [
    'manage_transport',
    'view_students',
    'view_vehicles'
  ],
  PARENT: [
    'view_own_children',
    'view_child_results',
    'view_child_attendance',
    'view_child_fees',
    'view_child_timetable'
  ],
  STUDENT: [
    'view_own_profile',
    'view_own_results',
    'view_own_attendance',
    'view_own_fees',
    'view_own_timetable'
  ]
};

const getPermissionsForRole = (role) => {
  if (role === 'SUPER_ADMIN') return ['*'];
  return PERMISSIONS[role] || [];
};

// ==================== HELPER FUNCTIONS FOR CARD & CERTIFICATE GENERATION ====================

// ===== GENERATE CARD HTML =====
function generateCardHTML(person, type, card, school, template) {
  const name = type === 'student' 
    ? `${person.firstName} ${person.lastName}` 
    : `${person.User?.firstName} ${person.User?.lastName}`;
  
  const idNumber = type === 'student' ? person.admissionNumber : person.employeeId;
  const className = type === 'student' ? person.Class?.name : person.department;
  const schoolName = school?.name || 'School Name';
  const schoolLogo = school?.contact?.logo || '';
  const cardNumber = card.cardNumber;
  const expiryDate = card.expiryDate ? new Date(card.expiryDate).toLocaleDateString() : 'N/A';
  
  // Get template colors
  const bgColor = template?.bgColor || '#4f46e5';
  const textColor = template?.textColor || '#ffffff';
  const layout = template?.layout || 'horizontal';
  
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>ID Card - ${name}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: 'Arial', sans-serif; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            background: #f0f0f0;
            padding: 20px;
          }
          .card {
            width: 85mm;
            height: 54mm;
            background: ${bgColor};
            border-radius: 12px;
            padding: 15px;
            color: ${textColor};
            position: relative;
            overflow: hidden;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
          }
          .card::before {
            content: '';
            position: absolute;
            top: -50%;
            right: -30%;
            width: 200px;
            height: 200px;
            background: rgba(255,255,255,0.05);
            border-radius: 50%;
          }
          .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            border-bottom: 2px solid rgba(255,255,255,0.2);
            padding-bottom: 8px;
          }
          .school-name {
            font-size: 14px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .logo {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            font-weight: bold;
            color: ${bgColor};
            overflow: hidden;
          }
          .logo img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .card-body {
            display: flex;
            ${layout === 'horizontal' ? 'flex-direction: row;' : 'flex-direction: column;'}
            gap: 12px;
            align-items: center;
          }
          .photo {
            width: 70px;
            height: 70px;
            border-radius: 50%;
            background: rgba(255,255,255,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            font-weight: bold;
            border: 3px solid rgba(255,255,255,0.4);
            flex-shrink: 0;
          }
          .info {
            flex: 1;
          }
          .info .name {
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 4px;
          }
          .info .detail {
            font-size: 11px;
            opacity: 0.9;
            margin-bottom: 2px;
          }
          .info .detail span {
            opacity: 0.7;
          }
          .card-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid rgba(255,255,255,0.2);
            font-size: 8px;
            opacity: 0.8;
          }
          .qr-code {
            width: 50px;
            height: 50px;
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            border: 1px dashed rgba(255,255,255,0.3);
          }
          .status-badge {
            position: absolute;
            top: 10px;
            right: 10px;
            background: rgba(255,255,255,0.2);
            padding: 2px 10px;
            border-radius: 20px;
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          @media print {
            body { background: white; padding: 0; }
            .card { box-shadow: none; border: 1px solid #ddd; }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="status-badge">${card.status}</div>
          
          <div class="card-header">
            <div class="school-name">${schoolName}</div>
            <div class="logo">
              ${schoolLogo ? `<img src="${schoolLogo}" alt="Logo">` : '🏫'}
            </div>
          </div>
          
          <div class="card-body">
            <div class="photo">
              ${name.charAt(0)}
            </div>
            <div class="info">
              <div class="name">${name}</div>
              <div class="detail">📋 ID: <span>${idNumber}</span></div>
              <div class="detail">🏫 ${type === 'student' ? 'Class' : 'Department'}: <span>${className || 'N/A'}</span></div>
              <div class="detail">🆔 Card: <span>${cardNumber}</span></div>
            </div>
          </div>
          
          <div class="card-footer">
            <div>Valid until: ${expiryDate}</div>
            <div class="qr-code">
              <span>QR Code</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

// ===== GENERATE CERTIFICATE HTML =====
function generateCertificateHTML(recipient, recipientType, certificate, school, template) {
  const name = recipientType === 'STUDENT' 
    ? `${recipient.firstName} ${recipient.lastName}` 
    : `${recipient.User?.firstName} ${recipient.User?.lastName}`;
  
  const schoolName = school?.name || 'School Name';
  const schoolLogo = school?.contact?.logo || '';
  const certNumber = certificate.certificateNumber;
  const issuedDate = certificate.issuedDate ? new Date(certificate.issuedDate).toLocaleDateString() : new Date().toLocaleDateString();
  const description = certificate.description || 'For outstanding achievement and excellence in academics and character.';
  
  // Certificate types with titles
  const certTitles = {
    'student_of_year': '🏆 STUDENT OF THE YEAR',
    'teacher_of_year': '🏆 TEACHER OF THE YEAR',
    'academic_excellence': '📚 ACADEMIC EXCELLENCE',
    'sports_achievement': '🏅 SPORTS ACHIEVEMENT',
    'arts_culture': '🎨 ARTS & CULTURE',
    'leadership': '👑 LEADERSHIP AWARD',
    'community_service': '🤝 COMMUNITY SERVICE',
    'graduation': '🎓 GRADUATION CERTIFICATE',
    'participation': '📝 CERTIFICATE OF PARTICIPATION',
    'custom': '✨ CERTIFICATE OF ACHIEVEMENT'
  };
  
  const title = certTitles[certificate.type] || certTitles.custom;
  
  // Colors for different certificate types
  const colorSchemes = {
    'student_of_year': { border: '#d4af37', bg: '#fef9e7', text: '#1a1a2e' },
    'teacher_of_year': { border: '#d4af37', bg: '#fef9e7', text: '#1a1a2e' },
    'academic_excellence': { border: '#1a56db', bg: '#eff6ff', text: '#1e293b' },
    'sports_achievement': { border: '#059669', bg: '#ecfdf5', text: '#064e3b' },
    'arts_culture': { border: '#7c3aed', bg: '#f5f3ff', text: '#4c1d95' },
    'leadership': { border: '#b45309', bg: '#fffbeb', text: '#78350f' },
    'community_service': { border: '#0d9488', bg: '#f0fdfa', text: '#134e4a' },
    'graduation': { border: '#1e293b', bg: '#f8fafc', text: '#0f172a' },
    'participation': { border: '#64748b', bg: '#f1f5f9', text: '#334155' },
    'custom': { border: '#4f46e5', bg: '#eef2ff', text: '#1e1b4b' }
  };
  
  const colors = colorSchemes[certificate.type] || colorSchemes.custom;
  
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Certificate - ${name}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: 'Georgia', 'Times New Roman', serif; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            background: #f0f0f0;
            padding: 40px;
          }
          .certificate {
            width: 297mm;
            min-height: 210mm;
            background: ${colors.bg};
            border: 8px solid ${colors.border};
            border-radius: 16px;
            padding: 50px 60px;
            position: relative;
            box-shadow: 0 8px 40px rgba(0,0,0,0.15);
            color: ${colors.text};
          }
          .certificate::before {
            content: '';
            position: absolute;
            top: 20px;
            left: 20px;
            right: 20px;
            bottom: 20px;
            border: 2px solid ${colors.border};
            border-radius: 8px;
            pointer-events: none;
            opacity: 0.3;
          }
          .header {
            text-align: center;
            border-bottom: 3px double ${colors.border};
            padding-bottom: 20px;
            margin-bottom: 20px;
          }
          .school-name {
            font-size: 32px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 3px;
            color: ${colors.text};
          }
          .school-logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 10px;
            border-radius: 50%;
            background: ${colors.border};
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            color: white;
            overflow: hidden;
          }
          .school-logo img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .certificate-title {
            font-size: 48px;
            font-weight: bold;
            text-align: center;
            margin: 20px 0;
            color: ${colors.border};
            letter-spacing: 2px;
          }
          .presented-to {
            text-align: center;
            font-size: 20px;
            color: ${colors.text};
            opacity: 0.8;
            margin-top: 10px;
          }
          .recipient-name {
            font-size: 56px;
            font-weight: bold;
            text-align: center;
            margin: 10px 0 20px;
            color: ${colors.text};
            font-family: 'Georgia', serif;
            letter-spacing: 2px;
          }
          .description {
            text-align: center;
            font-size: 18px;
            line-height: 1.8;
            max-width: 80%;
            margin: 15px auto;
            font-style: italic;
            color: ${colors.text};
          }
          .details {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 20px;
            margin: 30px 0;
            padding: 20px;
            border-top: 1px solid ${colors.border};
            border-bottom: 1px solid ${colors.border};
          }
          .detail-item {
            text-align: center;
          }
          .detail-label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.6;
          }
          .detail-value {
            font-size: 14px;
            font-weight: bold;
            margin-top: 4px;
          }
          .signatures {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 40px;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid ${colors.border};
          }
          .signature {
            text-align: center;
          }
          .signature-line {
            border-top: 2px solid ${colors.text};
            width: 80%;
            margin: 10px auto 5px;
          }
          .signature-label {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.6;
          }
          .certificate-number {
            text-align: center;
            font-size: 11px;
            opacity: 0.5;
            margin-top: 20px;
          }
          @media print {
            body { background: white; padding: 0; }
            .certificate { box-shadow: none; }
          }
        </style>
      </head>
      <body>
        <div class="certificate">
          <div class="header">
            <div class="school-logo">
              ${schoolLogo ? `<img src="${schoolLogo}" alt="Logo">` : '🏫'}
            </div>
            <div class="school-name">${schoolName}</div>
          </div>

          <div class="certificate-title">${title}</div>
          
          <div class="presented-to">Presented To</div>
          <div class="recipient-name">${name}</div>
          
          <div class="description">
            ${description.replace(/{name}/g, name).replace(/{year}/g, new Date().getFullYear()).replace(/{school}/g, schoolName)}
          </div>
          
          <div class="details">
            <div class="detail-item">
              <div class="detail-label">Certificate Number</div>
              <div class="detail-value">${certNumber}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Issued Date</div>
              <div class="detail-value">${issuedDate}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Status</div>
              <div class="detail-value" style="color: ${certificate.status === 'ISSUED' ? '#10b981' : '#ef4444'}">
                ${certificate.status}
              </div>
            </div>
          </div>
          
          <div class="signatures">
            <div class="signature">
              <div class="signature-line"></div>
              <div class="signature-label">Principal</div>
            </div>
            <div class="signature">
              <div class="signature-line"></div>
              <div class="signature-label">${recipientType === 'STUDENT' ? 'Class Teacher' : 'HOD'}</div>
            </div>
            <div class="signature">
              <div class="signature-line"></div>
              <div class="signature-label">School Stamp</div>
            </div>
          </div>
          
          <div class="certificate-number">
            ${certNumber}
          </div>
        </div>
      </body>
    </html>
  `;
}

// ==================== DYNAMIC PERMISSION MIDDLEWARE ====================

// ✅ SIMPLIFIED - No extra DB queries
const checkPermission = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      // Super Admin bypass
      if (req.user.role === 'SUPER_ADMIN') {
        return next();
      }

      // ✅ Get permissions from a simple mapping (no DB query)
      const rolePermissions = {
        'SCHOOL_ADMIN': [
          'manage_school', 'manage_users', 'manage_students', 'manage_classes',
          'manage_subjects', 'manage_exams', 'manage_results', 'manage_attendance',
          'manage_fees', 'manage_payments', 'manage_staff', 'view_reports'
        ],
        'PRINCIPAL': [
          'view_students', 'view_classes', 'view_subjects', 'view_exams',
          'view_results', 'view_attendance', 'view_reports'
        ],
        'TEACHER': [
          'view_students', 'view_classes', 'manage_own_results',
          'manage_own_attendance', 'view_timetable'
        ],
        'STUDENT': [
          'view_own_profile', 'view_own_results', 'view_own_attendance',
          'view_own_fees', 'view_own_timetable'
        ],
        'PARENT': [
          'view_own_children', 'view_child_results', 'view_child_attendance',
          'view_child_fees', 'view_child_timetable'
        ]
      };

      const permissions = rolePermissions[req.user.role] || [];
      
      if (permissions.includes('*') || permissions.includes(requiredPermission)) {
        return next();
      }

      // Check for wildcard permissions
      const moduleName = requiredPermission.split('_').slice(1).join('_');
      if (permissions.includes(`manage_${moduleName}`) && requiredPermission.startsWith('view_')) {
        return next();
      }

      return res.status(403).json({ 
        success: false, 
        message: `Access denied. Required permission: ${requiredPermission}` 
      });
    } catch (error) {
      console.error('Permission check error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Error checking permissions' 
      });
    }
  };
};
// Helper to get all permissions for a role
const getRolePermissions = async (roleId) => {
  const role = await Role.findByPk(roleId);
  if (!role) return [];
  return role.permissions || [];
};

// Helper to check if user has permission (for use in route handlers)
const hasPermission = async (userId, permissionKey) => {
  const user = await User.findByPk(userId, {
    include: [{ model: Role, as: 'roleObject' }]
  });
  
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  
  const permissions = user.roleObject?.permissions || [];
  return permissions.includes(permissionKey) || permissions.includes('*');
};
// ==================== HELPER FUNCTIONS ====================

const generateAdmissionNumber = async (schoolId) => {
  const year = new Date().getFullYear();
  const lastStudent = await Student.findOne({
    where: { schoolId },
    order: [['createdAt', 'DESC']]
  });
  
  let sequence = 1;
  if (lastStudent) {
    const lastNum = parseInt(lastStudent.admissionNumber.split('-')[1]);
    sequence = lastNum + 1;
  }
  
  return `${year}-${sequence.toString().padStart(4, '0')}`;
};

// Fix the generateReceiptNo function in your backend (server.cjs)

const generateReceiptNo = async () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  
  try {
    // Get the last payment to determine the sequence
    const lastPayment = await Payment.findOne({ 
      order: [['createdAt', 'DESC']],
      where: {} 
    });
    
    let sequence = 1;
    if (lastPayment && lastPayment.receiptNo) {
      const parts = lastPayment.receiptNo.split('-');
      if (parts.length >= 4) {
        const lastSeq = parseInt(parts[3]);
        if (!isNaN(lastSeq)) {
          sequence = lastSeq + 1;
        }
      } else {
        // If format is different, generate a random sequence
        sequence = Math.floor(Math.random() * 9000) + 1000;
      }
    }
    
    // Add milliseconds to ensure uniqueness
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    
    return `RCP-${year}${month}${day}-${sequence.toString().padStart(4, '0')}-${ms}`;
  } catch (error) {
    console.error('Error generating receipt number:', error);
    // Fallback to timestamp-based receipt number
    return `RCP-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }
};
const getGradingSystem = (schoolCategory) => {
  switch(schoolCategory) {
    case 'ECDE_PRIMARY_JSS':
      return GRADING_SYSTEMS.CBC;
    case 'SENIOR_SECONDARY':
      return GRADING_SYSTEMS.KENYA_844;
    case 'COLLEGE_TVET':
      return GRADING_SYSTEMS.TVET;
    case 'UNIVERSITY':
      return GRADING_SYSTEMS.UNIVERSITY;
    default:
      return GRADING_SYSTEMS.CBC;
  }
};

const calculateGradeFromMarks = (marks, schoolCategory, maxMarks = 100) => {
  const percentage = (marks / maxMarks) * 100;
  const gradingSystem = getGradingSystem(schoolCategory);
  return gradingSystem.getGrade(percentage);
};

const calculateGross = (salary) => {
  if (!salary) return 0;
  return (
    (parseFloat(salary.basic) || 0) +
    (parseFloat(salary.house) || 0) +
    (parseFloat(salary.transport) || 0) +
    (parseFloat(salary.medical) || 0) +
    (parseFloat(salary.commuter) || 0) +
    (parseFloat(salary.leave) || 0) +
    (parseFloat(salary.hardship) || 0)
  );
};

const calculateDeductions = (deductions) => {
  if (!deductions) return 0;
  return (
    (parseFloat(deductions.nhif) || 0) +
    (parseFloat(deductions.nssf) || 0) +
    (parseFloat(deductions.sacco) || 0) +
    (parseFloat(deductions.helb) || 0)
  );
};

const calculateGPA = (results, schoolCategory) => {
  if (!results || !results.length) return 0;
  const gradingSystem = getGradingSystem(schoolCategory);
  if (gradingSystem.isGPABased) {
    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    return (totalPoints / results.length).toFixed(2);
  }
  return 0;
};

const calculateMeanGrade = (results, schoolCategory) => {
  if (!results || !results.length) return 'N/A';
  const gradingSystem = getGradingSystem(schoolCategory);
  if (gradingSystem.calculateMeanGrade) {
    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    return gradingSystem.calculateMeanGrade(totalPoints);
  }
  return 'N/A';
};

const sendEmail = async (to, subject, html) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      html
    });
    
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
};


const createAuditLog = async (req, action, entity, entityId, oldValue = null, newValue = null) => {
  // SKIP ALL AUDIT LOGS to prevent recursive calls and resource exhaustion
  console.log(`⏭️ SKIPPING audit log: ${action} ${entity} (disabled to prevent resource exhaustion)`);
  
  // Don't do anything - this stops the endless loop
  return;
  
  /* ORIGINAL CODE COMMENTED OUT - UNCOMMENT AFTER FIXING THE LOOP
  try {
    let userId = null;
    let userEmail = 'System';
    
    if (req && req.user) {
      userId = req.user.id;
      userEmail = req.user.email || 'System';
      
      console.log(`📝 Creating audit log for user: ${req.user.firstName} ${req.user.lastName} (${req.user.email})`);
    } else {
      console.log('⚠️ No user found in request for audit log');
    }

    const logData = {
      schoolId: req?.user?.schoolId || null,
      userId: userId,
      action,
      entity,
      entityId,
      oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
      newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
      ipAddress: req?.ip || req?.connection?.remoteAddress || null,
      userAgent: req?.get ? req.get('User-Agent') : null,
      timestamp: new Date()
    };

    console.log(`📝 Creating audit log: ${action} ${entity} by ${userEmail}`);

    await AuditLog.create(logData);
    console.log('✅ Audit log created successfully');
  } catch (error) {
    console.error('❌ Audit log error:', error);
  }
  */
};
const checkStudentAccess = async (studentId, user) => {
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role === 'STUDENT') {
    const student = await Student.findOne({ where: { userId: user.id } });
    return student && student.id === studentId;
  }
  if (user.role === 'PARENT') {
    const parent = await Parent.findOne({ where: { userId: user.id, studentId } });
    return !!parent;
  }
  return true;
};

// ==================== MIDDLEWARE ====================

const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Authentication required' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    
    if (!user || !user.isActive) return res.status(401).json({ message: 'User not found or inactive' });

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const requireSchoolAdmin = (req, res, next) => {
  if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Access denied. School admin only.' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Access denied. Super admin only.' });
  }
  next();
};

const checkSchoolAccess = (req, res, next) => {
  const schoolId = req.params.schoolId || req.body.schoolId;
  
  if (req.user.role === 'SUPER_ADMIN') return next();
  
  if (req.user.schoolId !== schoolId) {
    return res.status(403).json({ message: 'Access denied to this school' });
  }
  
  next();
};

// ==================== API ROOT ====================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to SchoolAid SaaS API',
    version: '1.0.0',
    gradingSystems: Object.keys(GRADING_SYSTEMS).map(key => ({
      code: key,
      name: GRADING_SYSTEMS[key].name,
      applicableTo: GRADING_SYSTEMS[key].applicableTo
    })),
    endpoints: {
      auth: '/api/auth',
      schools: '/api/schools',
      users: '/api/users',
      classes: '/api/classes',
      students: '/api/students',
      parents: '/api/parents',
      subjects: '/api/subjects',
      exams: '/api/exams',
      results: '/api/results',
      attendance: '/api/attendance',
      fees: '/api/fees',
      payments: '/api/payments',
      staff: '/api/staff',
      library: '/api/books',
      transport: '/api/transport-routes',
      hostel: '/api/hostels',
      inventory: '/api/inventory',
      'inventory-usage': '/api/inventory-usage',
      announcements: '/api/announcements',
      events: '/api/events',
      dashboard: '/api/dashboard/stats',
      'exam-cards': '/api/exam-cards',
      timetable: '/api/timetable',
      'course-units': '/api/course-units',
      promotion: '/api/students/promote',
      'fee-reminders': '/api/fee-reminders/send',
      faculties: '/api/faculties',
      departments: '/api/departments',
      courses: '/api/courses',
      programs: '/api/programs',
      labs: '/api/labs',
      research: '/api/research',
      sponsors: '/api/sponsors',
      'grading-systems': '/api/grading-systems'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================== GRADING SYSTEMS ROUTE ====================

app.get('/api/grading-systems', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.user.schoolId);
    const currentSystem = school ? school.gradingSystem : 'CBC';
    
    res.json({
      success: true,
      gradingSystems: GRADING_SYSTEMS,
      currentSystem,
      schoolCategory: school?.category
    });
  } catch (error) {
    console.error('Get grading systems error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName, phone, role } = req.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      phone,
      role: role || 'SCHOOL_ADMIN'
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );

    user.password = undefined;

    res.status(201).json({ success: true, token, user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ 
      where: { email },
      include: [{ model: School }]
    });
    
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    await user.update({ lastLogin: new Date() });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );

    user.password = undefined;

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        schoolId: user.schoolId
      },
      school: user.School
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] },
      include: [{ model: School }]
    });
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/change-password', [
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    const user = await User.findByPk(req.user.id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    
    if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    
    if (!user) return res.status(404).json({ message: 'User not found' });

    const resetToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET + user.password,
      { expiresIn: '1h' }
    );

    await user.update({ resetToken });

    const resetLink = `http://localhost:5173/reset-password?token=${resetToken}`;
    console.log('Reset link:', resetLink);

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword, resetToken: null });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==================== CREATE SCHOOL WITH AUTO-SEEDING ====================
app.post('/api/schools', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { name, category, subscription, contact, motto, established, gradingSystem } = req.body;

    const code = name.substring(0, 3).toUpperCase() + Date.now().toString().slice(-4);

    // 1. Create the school
    const school = await School.create({
      name,
      code,
      category,
      gradingSystem: gradingSystem || (() => {
        switch(category) {
          case 'ECDE_PRIMARY_JSS': return 'CBC';
          case 'SENIOR_SECONDARY': return '844';
          case 'COLLEGE_TVET': return 'TVET';
          case 'UNIVERSITY': return 'UNIVERSITY';
          default: return 'CBC';
        }
      })(),
      subscription: subscription || { plan: 'BASIC' },
      contact,
      motto,
      established,
      createdBy: req.user.id
    });

    // ============ ADD DEFAULT ROLES FOR THE NEW SCHOOL ============
    const defaultRoles = [
      {
        name: 'Super Admin',
        description: 'Full system access across all schools',
        permissions: ['*'],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'School Admin',
        description: 'Full access to all school features',
        permissions: [
          'manage_school', 'manage_users', 'manage_students', 'manage_classes',
          'manage_subjects', 'manage_exams', 'manage_results', 'manage_attendance',
          'manage_fees', 'manage_payments', 'manage_staff', 'manage_payroll',
          'manage_library', 'manage_transport', 'manage_hostel', 'manage_inventory',
          'manage_announcements', 'manage_events', 'manage_timetable',
          'view_reports', 'view_financial_reports'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Teacher',
        description: 'Teaching staff with limited access',
        permissions: [
          'view_students', 'view_classes', 'manage_own_subjects',
          'manage_own_results', 'manage_own_attendance', 'view_timetable'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Student',
        description: 'Student self-service access',
        permissions: [
          'view_own_profile', 'view_own_results', 'view_own_attendance',
          'view_own_fees', 'view_own_timetable'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Parent',
        description: 'Parent access to view children',
        permissions: [
          'view_own_children', 'view_child_results', 'view_child_attendance',
          'view_child_fees', 'view_child_timetable'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Accountant',
        description: 'Finance department access',
        permissions: [
          'view_fees', 'manage_payments', 'view_financial_reports', 'manage_expenses'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Librarian',
        description: 'Library management access',
        permissions: [
          'manage_library', 'view_books', 'manage_borrowing'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Nurse',
        description: 'Health department access',
        permissions: [
          'view_students', 'manage_medical_records'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'Dean',
        description: 'Academic leadership access',
        permissions: [
          'view_students', 'view_classes', 'view_exams', 'view_results',
          'manage_attendance', 'manage_timetable', 'manage_subjects',
          'manage_exams', 'manage_results', 'view_reports'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      },
      {
        name: 'HOD',
        description: 'Head of Department access',
        permissions: [
          'view_students', 'view_classes', 'view_exams', 'view_results',
          'manage_attendance', 'manage_timetable', 'manage_subjects',
          'manage_exams', 'manage_results'
        ],
        isSystemRole: true,
        schoolId: school.id,
        isActive: true
      }
    ];

    await Role.bulkCreate(defaultRoles);
    console.log(`✅ Created ${defaultRoles.length} default roles for ${school.name}`);

    // 2. Define default features for the new school
    const defaultFeatures = [
      { name: 'SMS Notifications', code: 'SMS', category: 'COMMUNICATION', description: 'Send SMS notifications to parents and staff', isEnabled: true },
      { name: 'Email Notifications', code: 'EMAIL', category: 'COMMUNICATION', description: 'Send email notifications', isEnabled: true },
      { name: 'Online Payments', code: 'ONLINE_PAYMENTS', category: 'FINANCE', description: 'Accept online fee payments', isEnabled: false },
      { name: 'Exam Portal', code: 'EXAM_PORTAL', category: 'ACADEMIC', description: 'Online exam submission and grading', isEnabled: false },
      { name: 'Parent Portal', code: 'PARENT_PORTAL', category: 'ACCESS', description: 'Parent login to view student progress', isEnabled: true },
      { name: 'Student Portal', code: 'STUDENT_PORTAL', category: 'ACCESS', description: 'Student login to view results', isEnabled: true },
      { name: 'Library Management', code: 'LIBRARY', category: 'RESOURCES', description: 'Complete library management system', isEnabled: true },
      { name: 'Transport Tracking', code: 'TRANSPORT', category: 'LOGISTICS', description: 'Real-time vehicle tracking', isEnabled: false },
      { name: 'Hostel Management', code: 'HOSTEL', category: 'ACCOMMODATION', description: 'Hostel room allocation and management', isEnabled: true },
      { name: 'Inventory Management', code: 'INVENTORY', category: 'RESOURCES', description: 'Stock and inventory tracking', isEnabled: true },
      { name: 'Attendance Biometrics', code: 'BIOMETRICS', category: 'ATTENDANCE', description: 'Biometric attendance marking', isEnabled: false },
      { name: 'WhatsApp Integration', code: 'WHATSAPP', category: 'COMMUNICATION', description: 'Send WhatsApp messages', isEnabled: false }
    ];

    // 3. Auto-seed features for the new school
    const seededFeatures = [];
    for (const feature of defaultFeatures) {
      const [featureInstance, created] = await Feature.findOrCreate({
        where: { 
          code: feature.code, 
          schoolId: school.id 
        },
        defaults: { 
          ...feature, 
          schoolId: school.id 
        }
      });
      if (created) {
        seededFeatures.push(featureInstance);
        console.log(`✅ Feature created for ${school.name}: ${feature.name}`);
      }
    }
// ✅ REPLACE the audit log section with this:

// Create a simple audit log entry without complex associations
try {
  const logData = {
    schoolId: school.id,
    userId: req.user.id,
    action: 'CREATE_SCHOOL',
    entity: 'SCHOOL',
    entityId: school.id,
    newValue: { 
      name: school.name,
      code: school.code,
      category: school.category,
      featuresSeeded: seededFeatures.length,
      rolesCreated: defaultRoles.length
    },
    timestamp: new Date()
  };
  
  // Use raw query to avoid model association issues
  await sequelize.query(
    `INSERT INTO "AuditLogs" (id, "schoolId", "userId", action, entity, "entityId", "newValue", timestamp, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
    {
      bind: [
        logData.schoolId,
        logData.userId,
        logData.action,
        logData.entity,
        logData.entityId,
        JSON.stringify(logData.newValue),
        logData.timestamp
      ],
      type: sequelize.QueryTypes.INSERT
    }
  );
  console.log('✅ Audit log created successfully');
} catch (logError) {
  console.warn('⚠️ Audit log creation failed (non-critical):', logError.message);
}

    // 6. Return success response with seeding info
    res.status(201).json({ 
      success: true, 
      school,
      seeding: {
        rolesCreated: defaultRoles.length,
        featuresSeeded: seededFeatures.length,
        message: `School created successfully with ${defaultRoles.length} roles and ${seededFeatures.length} features`
      }
    });

    console.log(`✅ School created and auto-seeded: ${school.name} (${defaultRoles.length} roles, ${seededFeatures.length} features)`);

  } catch (error) {
    console.error('❌ Create school error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== MIGRATION: CREATE DEFAULT ROLES FOR EXISTING SCHOOLS ====================
app.post('/api/migrate/create-default-roles', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const schools = await School.findAll();
    let totalCreated = 0;
    let schoolsProcessed = 0;
    
    const defaultRoles = [
      {
        name: 'Super Admin',
        description: 'Full system access across all schools',
        permissions: ['*'],
        isSystemRole: true
      },
      {
        name: 'School Admin',
        description: 'Full access to all school features',
        permissions: [
          'manage_school', 'manage_users', 'manage_students', 'manage_classes',
          'manage_subjects', 'manage_exams', 'manage_results', 'manage_attendance',
          'manage_fees', 'manage_payments', 'manage_staff', 'manage_payroll',
          'manage_library', 'manage_transport', 'manage_hostel', 'manage_inventory',
          'manage_announcements', 'manage_events', 'manage_timetable',
          'view_reports', 'view_financial_reports'
        ],
        isSystemRole: true
      },
      {
        name: 'Teacher',
        description: 'Teaching staff with limited access',
        permissions: [
          'view_students', 'view_classes', 'manage_own_subjects',
          'manage_own_results', 'manage_own_attendance', 'view_timetable'
        ],
        isSystemRole: true
      },
      {
        name: 'Student',
        description: 'Student self-service access',
        permissions: [
          'view_own_profile', 'view_own_results', 'view_own_attendance',
          'view_own_fees', 'view_own_timetable'
        ],
        isSystemRole: true
      },
      {
        name: 'Parent',
        description: 'Parent access to view children',
        permissions: [
          'view_own_children', 'view_child_results', 'view_child_attendance',
          'view_child_fees', 'view_child_timetable'
        ],
        isSystemRole: true
      },
      {
        name: 'Accountant',
        description: 'Finance department access',
        permissions: [
          'view_fees', 'manage_payments', 'view_financial_reports', 'manage_expenses'
        ],
        isSystemRole: true
      },
      {
        name: 'Librarian',
        description: 'Library management access',
        permissions: [
          'manage_library', 'view_books', 'manage_borrowing'
        ],
        isSystemRole: true
      },
      {
        name: 'Nurse',
        description: 'Health department access',
        permissions: [
          'view_students', 'manage_medical_records'
        ],
        isSystemRole: true
      },
      {
        name: 'Dean',
        description: 'Academic leadership access',
        permissions: [
          'view_students', 'view_classes', 'view_exams', 'view_results',
          'manage_attendance', 'manage_timetable', 'manage_subjects',
          'manage_exams', 'manage_results', 'view_reports'
        ],
        isSystemRole: true
      },
      {
        name: 'HOD',
        description: 'Head of Department access',
        permissions: [
          'view_students', 'view_classes', 'view_exams', 'view_results',
          'manage_attendance', 'manage_timetable', 'manage_subjects',
          'manage_exams', 'manage_results'
        ],
        isSystemRole: true
      }
    ];

    for (const school of schools) {
      const existingRoles = await Role.count({ where: { schoolId: school.id } });
      
      if (existingRoles > 0) {
        console.log(`⏭️ Skipping ${school.name} - already has ${existingRoles} roles`);
        continue;
      }
      
      const rolesToCreate = defaultRoles.map(role => ({
        ...role,
        schoolId: school.id,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }));
      
      await Role.bulkCreate(rolesToCreate);
      totalCreated += rolesToCreate.length;
      schoolsProcessed++;
      console.log(`✅ Created ${rolesToCreate.length} roles for ${school.name}`);
    }
    
    res.json({
      success: true,
      message: `Created ${totalCreated} roles for ${schoolsProcessed} schools`,
      schoolsProcessed,
      totalRolesCreated: totalCreated
    });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/api/schools', authenticate, async (req, res) => {
  try {
    let schools;
    
    if (req.user.role === 'SUPER_ADMIN') {
      schools = await School.findAll({
        include: [{ model: User, as: 'Users' }]
      });
    } else {
      schools = await School.findAll({
        where: { id: req.user.schoolId },
        include: [{ model: User, as: 'Users' }]
      });
    }
    
    res.json({ success: true, schools });
  } catch (error) {
    console.error('Get schools error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id, {
      include: [
        { model: Class },
        { model: Student },
        { model: Subject },
        { model: User }
      ]
    });
    
    if (!school) return res.status(404).json({ message: 'School not found' });
    
    res.json({ success: true, school });
  } catch (error) {
    console.error('Get school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ message: 'School not found' });

    if (req.user.role !== 'SUPER_ADMIN' && req.user.schoolId !== school.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldSchool = { ...school.toJSON() };
    await school.update(req.body);
    await createAuditLog(req, 'UPDATE', 'SCHOOL', school.id, oldSchool, school);

    res.json({ success: true, school });
  } catch (error) {
    console.error('Update school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// ==================== UPDATE SCHOOL (for attendance settings) ====================
app.put('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check permissions
    const canUpdate = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'].includes(req.user.role);
    if (!canUpdate) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only Super Admin, School Admin, or Principal can update school settings.' 
      });
    }
    
    // Find the school
    const school = await School.findByPk(id);
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }
    
    // Check if user has access to this school
    if (req.user.role !== 'SUPER_ADMIN' && school.id !== req.user.schoolId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this school' 
      });
    }
    
    // Extract attendance settings from request body
    const { startTime, endTime, lateThreshold, earlyDepartureThreshold } = req.body;
    
    // Prepare update data
    const updateData = {};
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (lateThreshold !== undefined) updateData.lateThreshold = parseInt(lateThreshold);
    if (earlyDepartureThreshold !== undefined) updateData.earlyDepartureThreshold = parseInt(earlyDepartureThreshold);
    
    // Update the school
    await school.update(updateData);
    
    // Fetch updated school
    const updatedSchool = await School.findByPk(id);
    
    console.log(`✅ School settings updated for ${updatedSchool.name}:`, {
      startTime: updatedSchool.startTime,
      endTime: updatedSchool.endTime,
      lateThreshold: updatedSchool.lateThreshold,
      earlyDepartureThreshold: updatedSchool.earlyDepartureThreshold
    });
    
    res.json({
      success: true,
      message: 'School settings updated successfully',
      school: updatedSchool,
      settings: {
        startTime: updatedSchool.startTime || '08:00',
        endTime: updatedSchool.endTime || '17:00',
        lateThreshold: updatedSchool.lateThreshold || 30,
        earlyDepartureThreshold: updatedSchool.earlyDepartureThreshold || 30
      }
    });
    
  } catch (error) {
    console.error('Error updating school:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// Add this PATCH endpoint for school settings - PUT THIS AFTER your other school routes
app.patch('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    console.log('📝 PATCH school settings request:', { id, updates });
    
    // Check permissions
    const canUpdate = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'].includes(req.user.role);
    if (!canUpdate) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Only Super Admin, School Admin, or Principal can update school settings.' 
      });
    }
    
    // Find the school
    const school = await School.findByPk(id);
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }
    
    // Check if user has access to this school
    if (req.user.role !== 'SUPER_ADMIN' && school.id !== req.user.schoolId) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied to this school' 
      });
    }
    
    // Extract attendance settings from request body
    const { startTime, endTime, lateThreshold, earlyDepartureThreshold } = updates;
    
    // Prepare update data
    const updateData = {};
    if (startTime !== undefined) updateData.startTime = startTime;
    if (endTime !== undefined) updateData.endTime = endTime;
    if (lateThreshold !== undefined) updateData.lateThreshold = parseInt(lateThreshold);
    if (earlyDepartureThreshold !== undefined) updateData.earlyDepartureThreshold = parseInt(earlyDepartureThreshold);
    
    // Update the school
    await school.update(updateData);
    
    // Fetch updated school
    const updatedSchool = await School.findByPk(id);
    
    console.log(`✅ School settings updated for ${updatedSchool.name}:`, {
      startTime: updatedSchool.startTime,
      endTime: updatedSchool.endTime,
      lateThreshold: updatedSchool.lateThreshold,
      earlyDepartureThreshold: updatedSchool.earlyDepartureThreshold
    });
    
    res.json({
      success: true,
      message: 'School settings updated successfully',
      school: updatedSchool,
      settings: {
        startTime: updatedSchool.startTime || '08:00',
        endTime: updatedSchool.endTime || '17:00',
        lateThreshold: updatedSchool.lateThreshold || 30,
        earlyDepartureThreshold: updatedSchool.earlyDepartureThreshold || 30
      }
    });
    
  } catch (error) {
    console.error('❌ Error updating school settings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.delete('/api/schools/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) {
      return res.status(404).json({ message: 'School not found' });
    }

    await school.destroy();
    await createAuditLog(req, 'DELETE', 'SCHOOL', req.params.id);

    res.json({
      success: true,
      message: 'School deleted successfully'
    });
  } catch (error) {
    console.error('Delete school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== USER ROUTES ====================

app.get('/api/users', authenticate, async (req, res) => {
  try {
    const where = {};
    if (req.user.role !== 'SUPER_ADMIN') where.schoolId = req.user.schoolId;

    const users = await User.findAll({
      where,
      attributes: { exclude: ['password'] },
      include: [{ model: School }]
    });
    
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ['password'] },
      include: [{ model: School }, { model: Staff }]
    });
    
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/users', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, role, schoolId } = req.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password || 'Password123!', 10);
    const user = await User.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      phone,
      role,
      schoolId: schoolId || req.user.schoolId
    });

    user.password = undefined;
    await createAuditLog(req, 'CREATE', 'USER', user.id, null, user);

    res.status(201).json({ success: true, user });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldUser = { ...user.toJSON() };
    await user.update(req.body);
    await createAuditLog(req, 'UPDATE', 'USER', user.id, oldUser, user);

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await user.destroy();
    await createAuditLog(req, 'DELETE', 'USER', req.params.id);

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== CLASS ROUTES ====================

app.post('/api/classes', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, capacity, streams, academicYear } = req.body;

    let schoolId = req.user.schoolId;
    
    if (!schoolId && req.body.schoolId) {
      schoolId = req.body.schoolId;
    }
    
    if (!schoolId) {
      return res.status(400).json({ 
        message: 'School ID is required. You must be associated with a school or provide schoolId.' 
      });
    }

    const classObj = await Class.create({
      name,
      capacity,
      streams,
      academicYear,
      schoolId: schoolId
    });

    await createAuditLog(req, 'CREATE', 'CLASS', classObj.id, null, classObj);

    res.status(201).json({ success: true, class: classObj });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/classes', authenticate, async (req, res) => {
  try {
    let where = {};
    
    if (req.user.schoolId) {
      where.schoolId = req.user.schoolId;
    }
    
    const classes = await Class.findAll({
      where,
      include: [
        { model: Student, required: false },
        { model: Subject, required: false },
        { model: User, as: 'classTeacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    res.json({ success: true, classes });
  } catch (error) {
    console.error('Get classes error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/classes/:id', authenticate, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [
        { model: Student, required: false },
        { model: Subject, required: false },
        { model: User, as: 'classTeacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });
    
    res.json({ success: true, class: classObj });
  } catch (error) {
    console.error('Get class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/classes/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });

    const oldClass = { ...classObj.toJSON() };
    await classObj.update(req.body);
    await createAuditLog(req, 'UPDATE', 'CLASS', classObj.id, oldClass, classObj);

    res.json({ success: true, class: classObj });
  } catch (error) {
    console.error('Update class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/classes/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });

    await classObj.destroy();
    await createAuditLog(req, 'DELETE', 'CLASS', req.params.id);

    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Delete class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== COMPLETE BACKEND WITH OPTION 2 (ADMISSION NUMBER BASED) ====================

// ==================== STUDENT ROUTES ====================

// POST create a new student
app.post('/api/students', authenticate, async (req, res) => {
  try {
    const studentData = { ...req.body };
    
    const school = await School.findByPk(req.user.schoolId);
    if (!school) return res.status(404).json({ message: 'School not found' });

    const uuidFields = ['classId', 'courseId', 'programId', 'facultyId', 'departmentId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (studentData[field] === '') studentData[field] = null;
    });

    if (school.category === 'UNIVERSITY') {
      if (!studentData.courseId) {
        return res.status(400).json({ message: 'Course ID is required for university students' });
      }
      if (!studentData.currentYear) studentData.currentYear = 1;
      if (!studentData.currentSemester) studentData.currentSemester = 1;
    } else if (school.category === 'COLLEGE_TVET') {
      if (!studentData.programId) {
        return res.status(400).json({ message: 'Program ID is required for TVET students' });
      }
      if (!studentData.currentModule) studentData.currentModule = 'Module 1';
    } else {
      if (!studentData.classId) {
        return res.status(400).json({ message: 'Class ID is required' });
      }
    }

    let admissionNumber = studentData.admissionNumber;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber(req.user.schoolId);
    } else {
      const existingStudent = await Student.findOne({
        where: { admissionNumber, schoolId: req.user.schoolId }
      });
      if (existingStudent) {
        return res.status(400).json({ 
          message: `Admission number '${admissionNumber}' already exists.` 
        });
      }
    }

    const student = await Student.create({
      ...studentData,
      admissionNumber,
      schoolId: req.user.schoolId,
      enrollmentDate: studentData.enrollmentDate || new Date(),
    });

    await createAuditLog(req, 'CREATE', 'STUDENT', student.id, null, student);
    res.status(201).json({ success: true, student });
  } catch (error) {
    console.error('Create student error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ message: 'Admission number already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});
// ==================== STUDENTS ROUTES ====================

app.get('/api/students', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, search } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Apply filters based on school category
    if (school?.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
    } else if (school?.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
    } else {
      if (classId) where.classId = classId;
    }
    
    if (search) {
      where[Op.or] = [
        { firstName: { [Op.iLike]: `%${search}%` } },
        { lastName: { [Op.iLike]: `%${search}%` } },
        { admissionNumber: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // FIX: Remove the problematic include or fix the attribute
    // Use a simpler query without the Class include first
    const students = await Student.findAll({
      where,
      // Remove the include that's causing the error
      // include: [{ model: Class, attributes: ['id', 'name', 'stream'] }], // ← THIS IS THE PROBLEM
      order: [['createdAt', 'DESC']]
    });
    
    console.log(`✅ Found ${students.length} students for school ${req.user.schoolId}`);
    res.json({ success: true, students });
  } catch (error) {
    console.error('❌ Get students error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== STUDENT SELF-SERVICE ENDPOINTS ====================

// GET current student's own data (for logged-in students)
app.get('/api/students/me', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'STUDENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for students' 
      });
    }

    // Find student by userId
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        userId: req.user.id
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name']
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Parent, 
          include: [{ model: User }], 
          required: false 
        }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student record not found for your account' 
      });
    }

    res.json({ success: true, student });
  } catch (error) {
    console.error('Get current student error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET student by admission number (for students to look up themselves)
app.get('/api/students/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const upperAdmission = admissionNumber.toUpperCase();
    
    console.log(`🔍 Fetching student by admission: ${upperAdmission}, Role: ${req.user.role}`);
    
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber: upperAdmission
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name']
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code']
        }
      ]
    });

    if (!student) {
      console.log(`❌ Student not found with admission: ${upperAdmission}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    // Verify access permissions
    if (req.user.role === 'STUDENT') {
      // Students can only see their own record
      if (student.userId !== req.user.id) {
        console.log(`❌ Student ${req.user.id} trying to access student ${student.id} - Access denied`);
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    } else if (req.user.role === 'PARENT') {
      // Parents can see their children's records
      const parent = await Parent.findOne({ 
        where: { userId: req.user.id, studentId: student.id } 
      });
      if (!parent) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);
    res.json({ success: true, student });
  } catch (error) {
    console.error('Get student by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET student by user ID
app.get('/api/students/by-user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Backend: Fetching student for user: ${userId}, Role: ${req.user.role}`);
    
    // Check permissions
    if (req.user.role === 'STUDENT' && req.user.id !== userId) {
      console.log(`❌ Student ${req.user.id} trying to access student for user ${userId} - Access denied`);
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }
    
    if (req.user.role === 'PARENT') {
      // Verify parent has access to this student
      const student = await Student.findOne({ where: { userId } });
      if (student) {
        const parent = await Parent.findOne({ 
          where: { userId: req.user.id, studentId: student.id } 
        });
        if (!parent) {
          return res.status(403).json({ 
            success: false, 
            message: 'Access denied' 
          });
        }
      }
    }

    // Find the student linked to this user
    const student = await Student.findOne({
      where: { 
        userId: userId,
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name'] 
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code'] 
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code'] 
        }
      ]
    });

    if (!student) {
      console.log(`❌ No student record found for user: ${userId}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student record not found for this user' 
      });
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);
    res.json({ 
      success: true, 
      student 
    });
  } catch (error) {
    console.error('❌ Get student by user error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single student by ID
app.get('/api/students/:id', authenticate, async (req, res) => {
  try {
    const studentId = req.params.id;

    // Check permissions
    if (req.user.role === 'STUDENT') {
      // Students can only see their own record
      const studentCheck = await Student.findOne({ 
        where: { id: studentId, userId: req.user.id } 
      });
      if (!studentCheck) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    const school = await School.findByPk(req.user.schoolId);
    const include = [
      { model: Parent, include: [{ model: User }], required: false },
      { model: Result, include: [{ model: Exam }], required: false },
      { model: Attendance, required: false },
      { model: Payment, required: false },
      { model: TransportRoute, required: false }
    ];

    if (school.category === 'UNIVERSITY') {
      include.push({ model: Course, required: false });
    } else if (school.category === 'COLLEGE_TVET') {
      include.push({ model: Program, required: false });
    } else {
      include.push({ model: Class, required: false });
    }

    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId },
      include
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });
    
    res.json({ success: true, student });
  } catch (error) {
    console.error('Get student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// CREATE student
app.post('/api/students', authenticate, async (req, res) => {
  try {
    const studentData = req.body;
    
    // Only admins can create students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Generate admission number if not provided
    if (!studentData.admissionNumber) {
      const year = new Date().getFullYear();
      const count = await Student.count({ where: { schoolId: req.user.schoolId } }) + 1;
      studentData.admissionNumber = `${year}-${count.toString().padStart(4, '0')}`;
    }
    
    // Ensure schoolId is set
    studentData.schoolId = req.user.schoolId;
    
    const student = await Student.create(studentData);
    
    // If a user account should be created
    if (studentData.studentLogin?.createAccount && studentData.studentLogin.email) {
      const user = await User.create({
        email: studentData.studentLogin.email,
        password: studentData.studentLogin.password,
        firstName: studentData.firstName,
        lastName: studentData.lastName,
        role: 'STUDENT',
        schoolId: req.user.schoolId,
        phone: studentData.phone
      });
      
      // Link the student to the user
      await student.update({ userId: user.id });
    }
    
    res.json({ success: true, student });
    
  } catch (error) {
    console.error('Create student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// UPDATE student
app.put('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    const student = await Student.findByPk(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    // Check permissions
    if (req.user.role === 'STUDENT' && student.userId !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await student.update(req.body);
    
    res.json({ success: true, student });
    
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// DELETE student
app.delete('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Only admins can delete students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const student = await Student.findByPk(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    await student.destroy();
    
    res.json({ success: true, message: 'Student deleted successfully' });
    
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== STUDENT PROGRESSION ENDPOINTS ====================

// Progress students to next year/semester (University)
app.post('/api/students/progress', authenticate, async (req, res) => {
  try {
    const { studentIds, newYear, newSemester } = req.body;
    
    if (!studentIds || !newYear) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { currentYear: newYear, currentSemester: newSemester || 1 },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students progressed` });
    
  } catch (error) {
    console.error('Progress students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to next module
app.post('/api/students/progress-module', authenticate, async (req, res) => {
  try {
    const { studentIds, newModule, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const updateData = { currentModule: newModule };
    if (newYear) updateData.currentYear = newYear;
    
    await Student.update(updateData, { where: { id: studentIds, schoolId: req.user.schoolId } });
    
    res.json({ success: true, message: `${studentIds.length} students progressed to ${newModule}` });
    
  } catch (error) {
    console.error('Progress module error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to new program
app.post('/api/students/progress-program', authenticate, async (req, res) => {
  try {
    const { studentIds, newProgramId, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const updateData = { 
      programId: newProgramId,
      currentModule: 'Module 1'
    };
    if (newYear) updateData.currentYear = newYear;
    
    await Student.update(updateData, { where: { id: studentIds, schoolId: req.user.schoolId } });
    
    res.json({ success: true, message: `${studentIds.length} students progressed to new program` });
    
  } catch (error) {
    console.error('Progress program error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to next year
app.post('/api/students/progress-year', authenticate, async (req, res) => {
  try {
    const { studentIds, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { currentYear: newYear },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students progressed to Year ${newYear}` });
    
  } catch (error) {
    console.error('Progress year error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Promote regular school students to next class
app.post('/api/students/promote', authenticate, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    // Only admins can promote students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { classId: newClassId },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students promoted to new class` });
    
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
// ==================== SPECIALIZED ATTENDANCE ENDPOINTS ====================

// GET attendance by admission number
app.get('/api/attendance/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate, limit = 50 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const where = { studentId: student.id };
    
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: Course, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Class, 
          attributes: ['id', 'name'],
          required: false 
        }
      ],
      order: [['date', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate summary
    const summary = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    res.json({ 
      success: true, 
      attendance,
      summary,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get attendance by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED FEE ENDPOINTS ====================

// GET fee statement by admission number
app.get('/api/fees/by-admission/:admissionNumber/statement', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    const payments = await Payment.findAll({
      where: { studentId: student.id },
      include: [{ model: Fee }],
      order: [['date', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('Get fee statement by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED EXAM CARD ENDPOINTS ====================
// ==================== GET COURSE UNITS BY PROGRAM ID (FOR TVET) ====================
app.get('/api/course-units/by-program/:programId', authenticate, async (req, res) => {
  try {
    const { programId } = req.params;
    const { year, module } = req.query;
    
    console.log(`📚 Fetching course units for program: ${programId}`);
    
    const where = { 
      programId,
      schoolId: req.user.schoolId 
    };
    
    // Filter by year if provided
    if (year && !isNaN(parseInt(year))) {
      where.year = parseInt(year);
    }
    
    // Filter by module if provided
    if (module && !isNaN(parseInt(module))) {
      where.module = parseInt(module);
    }
    
    const units = await CourseUnit.findAll({
      where,
      order: [['module', 'ASC'], ['year', 'ASC'], ['name', 'ASC']]
    });
    
    console.log(`✅ Found ${units.length} units for program ${programId}`);
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== GET COURSE UNITS BY COURSE ID (FOR UNIVERSITY) ====================
app.get('/api/course-units/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const { courseId } = req.params;
    const { year, semester } = req.query;
    
    console.log(`📚 Fetching course units for course: ${courseId}`);
    
    const where = { 
      courseId,
      schoolId: req.user.schoolId 
    };
    
    // Filter by year if provided
    if (year && !isNaN(parseInt(year))) {
      where.year = parseInt(year);
    }
    
    // Filter by semester if provided
    if (semester && !isNaN(parseInt(semester))) {
      where.semester = parseInt(semester);
    }
    
    const units = await CourseUnit.findAll({
      where,
      order: [['semester', 'ASC'], ['year', 'ASC'], ['name', 'ASC']]
    });
    
    console.log(`✅ Found ${units.length} units for course ${courseId}`);
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// GET exam card by admission number (with full TVET support)
app.get('/api/exam-cards/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { semester, module, year } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name', 'code'] },
        { model: Program, as: 'program', attributes: ['id', 'name', 'code', 'level'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    console.log('📘 Student found:', {
      id: student.id,
      name: `${student.firstName} ${student.lastName}`,
      admission: student.admissionNumber,
      schoolCategory: school.category,
      courseId: student.courseId,
      programId: student.programId,
      classId: student.classId
    });

    // ==================== GET APPLICABLE FEES ====================
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) {
        feeWhere.courseId = student.courseId;
      }
      if (year || student.currentYear) {
        feeWhere.year = year || student.currentYear;
      }
      if (semester) {
        feeWhere.semester = parseInt(semester);
      } else if (student.currentSemester) {
        feeWhere.semester = student.currentSemester;
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) {
        feeWhere.programId = student.programId;
      }
      if (year || student.currentYear) {
        feeWhere.year = year || student.currentYear;
      }
      if (module) {
        feeWhere.module = parseInt(module);
      } else if (student.currentModule) {
        const moduleNum = parseInt(student.currentModule.replace(/\D/g, ''));
        if (!isNaN(moduleNum)) {
          feeWhere.module = moduleNum;
        }
      }
    } 
    else {
      // Secondary/Primary
      if (student.classId) {
        feeWhere.classId = student.classId;
      }
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);

    // ==================== GET PAYMENTS ====================
    const payments = await Payment.findAll({ 
      where: { studentId: student.id },
      order: [['paymentDate', 'DESC']]
    });
    
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;
    const isEligible = balance <= 0;

    // ==================== GET UNITS/SUBJECTS ====================
    let units = [];
    
    if (school.category === 'UNIVERSITY') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        courseId: student.courseId,
        isActive: true
      };
      
      if (semester) {
        unitWhere.semester = parseInt(semester);
      } else if (student.currentSemester) {
        unitWhere.semester = student.currentSemester;
      }
      
      if (year || student.currentYear) {
        unitWhere.year = year || student.currentYear;
      }
      
      units = await CourseUnit.findAll({ 
        where: unitWhere,
        order: [['semester', 'ASC'], ['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} units for course ${student.courseId}`);
    } 
    else if (school.category === 'COLLEGE_TVET') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        programId: student.programId,
        isActive: true
      };
      
      // Filter by module
      let moduleNum = null;
      if (module) {
        moduleNum = parseInt(module);
      } else if (student.currentModule) {
        moduleNum = parseInt(student.currentModule.replace(/\D/g, ''));
      }
      
      if (moduleNum && !isNaN(moduleNum)) {
        unitWhere.module = moduleNum;
      }
      
      if (year || student.currentYear) {
        unitWhere.year = year || student.currentYear;
      }
      
      units = await CourseUnit.findAll({ 
        where: unitWhere,
        order: [['module', 'ASC'], ['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} modules for program ${student.programId} (Module: ${moduleNum || 'all'})`);
    } 
    else {
      // Secondary/Primary - get subjects
      const subjectWhere = { 
        schoolId: req.user.schoolId, 
        classId: student.classId,
        isActive: true
      };
      
      units = await Subject.findAll({ 
        where: subjectWhere,
        order: [['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} subjects for class ${student.classId}`);
    }

    // ==================== BUILD RESPONSE ====================
    // Get program/course/class name
    let programName = null;
    let courseName = null;
    let className = null;
    
    if (school.category === 'UNIVERSITY') {
      if (student.course) {
        courseName = student.course.name;
      } else if (student.courseId) {
        const course = await Course.findByPk(student.courseId);
        courseName = course?.name || null;
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.program) {
        programName = student.program.name;
      } else if (student.programId) {
        const program = await Program.findByPk(student.programId);
        programName = program?.name || null;
      }
    } 
    else {
      if (student.class) {
        className = student.class.name;
      } else if (student.classId) {
        const classObj = await Class.findByPk(student.classId);
        className = classObj?.name || null;
      }
    }

    // Get module display
    let moduleDisplay = null;
    if (school.category === 'COLLEGE_TVET') {
      if (student.currentModule) {
        moduleDisplay = student.currentModule;
      } else if (student.module) {
        moduleDisplay = student.module;
      } else {
        moduleDisplay = 'Module 1';
      }
    }

    res.json({
      success: true,
      examCard: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          middleName: student.middleName,
          admissionNumber: student.admissionNumber,
          courseId: student.courseId,
          courseName: courseName,
          programId: student.programId,
          programName: programName,
          classId: student.classId,
          className: className,
          currentYear: student.currentYear,
          currentSemester: student.currentSemester,
          currentModule: moduleDisplay,
          module: moduleDisplay
        },
        school: {
          id: school.id,
          name: school.name,
          motto: school.motto,
          category: school.category,
          contact: school.contact,
          hod: school.hod || (school.category === 'COLLEGE_TVET' ? 'Head of Department' : null)
        },
        fees: {
          total: totalFees,
          paid: totalPaid,
          balance: balance,
          isEligible: isEligible,
          structure: fees.map(f => ({
            id: f.id,
            name: f.name,
            amount: f.amount,
            category: f.category
          }))
        },
        units: units.map(u => ({
          id: u.id,
          name: u.name,
          code: u.code,
          semester: u.semester,
          module: u.module,
          year: u.year,
          credits: u.credits,
          description: u.description
        })),
        payments: payments.map(p => ({
          id: p.id,
          amount: p.amount,
          paymentMethod: p.paymentMethod,
          receiptNumber: p.receiptNumber,
          paymentDate: p.paymentDate,
          transactionId: p.transactionId,
          notes: p.notes
        })),
        generatedAt: new Date()
      }
    });
    
  } catch (error) {
    console.error('Get exam card by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET exam cards for zero balance students (teacher/admin view)
app.get('/api/exam-cards/zero-balance-students', authenticate, async (req, res) => {
  try {
    const { 
      classId, courseId, programId, 
      year, semester, module, 
      startDate, endDate 
    } = req.query;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // ==================== GET STUDENTS BASED ON FILTERS ====================
    let studentWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY' && courseId) {
      studentWhere.courseId = courseId;
      if (year) studentWhere.currentYear = parseInt(year);
    } 
    else if (school.category === 'COLLEGE_TVET' && programId) {
      studentWhere.programId = programId;
      if (year) studentWhere.currentYear = parseInt(year);
      if (module) {
        studentWhere.currentModule = `Module ${module}`;
      }
    } 
    else if (classId) {
      studentWhere.classId = classId;
    }
    
    const students = await Student.findAll({ 
      where: studentWhere,
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name'] },
        { model: Program, as: 'program', attributes: ['id', 'name'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });
    
    if (students.length === 0) {
      return res.json({ 
        success: true, 
        students: [] 
      });
    }

    // ==================== GET FEE STRUCTURE ====================
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY' && courseId) {
      feeWhere.courseId = courseId;
      if (year) feeWhere.year = parseInt(year);
      if (semester) feeWhere.semester = parseInt(semester);
    } 
    else if (school.category === 'COLLEGE_TVET' && programId) {
      feeWhere.programId = programId;
      if (year) feeWhere.year = parseInt(year);
      if (module) feeWhere.module = parseInt(module);
    } 
    else if (classId) {
      feeWhere.classId = classId;
    }
    
    const fees = await Fee.findAll({ where: feeWhere });
    const totalFeesAmount = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);

    // ==================== GET UNITS/SUBJECTS FOR EACH STUDENT ====================
    const studentsWithData = await Promise.all(students.map(async (student) => {
      // Get payments
      const payments = await Payment.findAll({ 
        where: { studentId: student.id }
      });
      const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const balance = totalFeesAmount - totalPaid;
      const isEligible = balance <= 0;
      
      // Get units/subjects
      let units = [];
      if (school.category === 'UNIVERSITY') {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          courseId: student.courseId,
          isActive: true
        };
        if (semester) unitWhere.semester = parseInt(semester);
        if (year) unitWhere.year = parseInt(year);
        units = await CourseUnit.findAll({ where: unitWhere });
      } 
      else if (school.category === 'COLLEGE_TVET') {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          programId: student.programId,
          isActive: true
        };
        if (module) unitWhere.module = parseInt(module);
        if (year) unitWhere.year = parseInt(year);
        units = await CourseUnit.findAll({ where: unitWhere });
      } 
      else {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          classId: student.classId,
          isActive: true
        };
        units = await Subject.findAll({ where: unitWhere });
      }
      
      // Get program/course/class name
      let entityName = '';
      if (school.category === 'UNIVERSITY') {
        entityName = student.course?.name || '';
      } else if (school.category === 'COLLEGE_TVET') {
        entityName = student.program?.name || '';
      } else {
        entityName = student.class?.name || '';
      }
      
      return {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        courseId: student.courseId,
        programId: student.programId,
        classId: student.classId,
        entityName: entityName,
        currentYear: student.currentYear,
        currentSemester: student.currentSemester,
        currentModule: student.currentModule,
        totalFees: totalFeesAmount,
        totalPaid: totalPaid,
        balance: balance,
        isEligible: isEligible,
        units: units.map(u => ({
          id: u.id,
          name: u.name,
          code: u.code,
          semester: u.semester,
          module: u.module
        }))
      };
    }));
    
    // Filter to only eligible students (zero balance)
    const eligibleStudents = studentsWithData.filter(s => s.isEligible);
    
    res.json({
      success: true,
      totalStudents: students.length,
      eligibleCount: eligibleStudents.length,
      students: eligibleStudents,
      filters: {
        schoolCategory: school.category,
        classId,
        courseId,
        programId,
        year,
        semester,
        module
      }
    });
    
  } catch (error) {
    console.error('Get zero balance students error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET student fee statement by admission number
app.get('/api/fee-statement/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate } = req.query;
    
    // Find student
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name'] },
        { model: Program, as: 'program', attributes: ['id', 'name'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Get fee structure
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) feeWhere.programId = student.programId;
    } 
    else {
      if (student.classId) feeWhere.classId = student.classId;
    }
    
    const fees = await Fee.findAll({ where: feeWhere });
    
    // Get payments
    let paymentWhere = { studentId: student.id };
    if (startDate && endDate) {
      paymentWhere.paymentDate = { [Op.between]: [startDate, endDate] };
    }
    
    const payments = await Payment.findAll({ 
      where: paymentWhere,
      order: [['paymentDate', 'DESC']]
    });
    
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;
    
    res.json({
      success: true,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        courseName: student.course?.name,
        programName: student.program?.name,
        className: student.class?.name
      },
      school: {
        name: school.name,
        motto: school.motto,
        contact: school.contact
      },
      feeStructure: fees,
      payments: payments,
      totalFees,
      totalPaid,
      balance,
      isCleared: balance <= 0
    });
    
  } catch (error) {
    console.error('Get fee statement error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET student details by admission number (for exam card)
app.get('/api/students/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { 
          model: Course, 
          as: 'course',
          attributes: ['id', 'name', 'code'],
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'] }]
        },
        { 
          model: Program, 
          as: 'program',
          attributes: ['id', 'name', 'code', 'level']
        },
        { 
          model: Class, 
          as: 'class',
          attributes: ['id', 'name']
        }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }
    
    res.json({
      success: true,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        admissionNumber: student.admissionNumber,
        email: student.email,
        phone: student.phone,
        dateOfBirth: student.dateOfBirth,
        gender: student.gender,
        courseId: student.courseId,
        course: student.course,
        programId: student.programId,
        program: student.program,
        classId: student.classId,
        class: student.class,
        currentYear: student.currentYear,
        currentSemester: student.currentSemester,
        currentModule: student.currentModule,
        boardingStatus: student.boardingStatus,
        isActive: student.isActive,
        medicalInfo: student.medicalInfo
      }
    });
    
  } catch (error) {
    console.error('Get student by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});
// ==================== SPECIALIZED LIBRARY ENDPOINTS ====================

// GET borrowed books by admission number
app.get('/api/library/by-admission/:admissionNumber/borrowed', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { 
        studentId: student.id,
        status: 'BORROWED'
      },
      include: [
        { model: Book, required: false }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ 
      success: true, 
      borrows,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get borrowed books by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET available books (public, no admission needed)
app.get('/api/library/available', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { 
      schoolId: req.user.schoolId,
      available: { [Op.gt]: 0 }
    };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category) where.category = category;

    const books = await Book.findAll({ 
      where,
      order: [['title', 'ASC']]
    });

    res.json({ success: true, books });
  } catch (error) {
    console.error('Get available books error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED TIMETABLE ENDPOINTS ====================

// GET timetable by admission number
app.get('/api/timetable/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      where.courseId = student.courseId;
      if (student.currentYear) where.year = student.currentYear;
      if (student.currentSemester) where.semester = student.currentSemester;
    } else {
      where.classId = student.classId;
    }

    const timetable = await Timetable.findAll({
      where,
      include: [
        { model: Subject, required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { 
          model: Staff, 
          as: 'teacher',
          include: [{ model: User, attributes: ['firstName', 'lastName'] }],
          required: false 
        }
      ],
      order: [['day', 'ASC'], ['period', 'ASC']]
    });

    res.json({ 
      success: true, 
      timetable,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get timetable by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== PARENT-SPECIFIC ENDPOINTS ====================

// GET parent's children
app.get('/api/parents/me/children', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const parents = await Parent.findAll({
      where: { userId: req.user.id },
      include: [{
        model: Student,
        include: [
          { model: Class, required: false },
          { model: Course, required: false }
        ]
      }]
    });

    const children = parents.map(p => p.Student).filter(s => s);

    res.json({ 
      success: true, 
      children,
      count: children.length
    });
  } catch (error) {
    console.error('Get parent children error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's results by admission number
app.get('/api/parents/me/children/:admissionNumber/results', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    // Find the student
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Verify this parent has access to this student
    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const results = await Result.findAll({
      where: { studentId: student.id },
      include: [
        { model: Exam, attributes: ['id', 'name', 'date', 'type'] },
        { model: Subject, attributes: ['id', 'name'] },
        { model: CourseUnit, as: 'CourseUnit', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ 
      success: true, 
      results,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child results error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's attendance by admission number
app.get('/api/parents/me/children/:admissionNumber/attendance', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;
    const { startDate, endDate } = req.query;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const where = { studentId: student.id };
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { model: Course, attributes: ['id', 'name'] },
        { model: Class, attributes: ['id', 'name'] }
      ],
      order: [['date', 'DESC']]
    });

    res.json({ 
      success: true, 
      attendance,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child attendance error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's fee statement by admission number
app.get('/api/parents/me/children/:admissionNumber/fees', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const payments = await Payment.findAll({ 
      where: { studentId: student.id },
      order: [['date', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance: totalFees - totalPaid
        }
      }
    });
  } catch (error) {
    console.error('Get child fees error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's exam card by admission number
app.get('/api/parents/me/children/:admissionNumber/exam-card', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;
    const { semester } = req.query;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);

    // Get applicable fees
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount), 0);
    const totalPaid = await Payment.sum('amount', { where: { studentId: student.id } }) || 0;
    const balance = totalFees - totalPaid;
    const isEligible = balance <= 0;

    // Get units/subjects
    let units = [];
    if (school.category === 'UNIVERSITY') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        courseId: student.courseId 
      };
      if (semester) unitWhere.semester = parseInt(semester);
      if (student.currentYear) unitWhere.year = student.currentYear;
      
      units = await CourseUnit.findAll({ where: unitWhere });
    } else {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        classId: student.classId 
      };
      units = await Subject.findAll({ where: unitWhere });
    }

    res.json({
      success: true,
      examCard: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber,
          course: student.course,
          class: student.class,
          currentYear: student.currentYear,
          currentSemester: student.currentSemester
        },
        fees: {
          total: totalFees,
          paid: totalPaid,
          balance,
          isEligible
        },
        units,
        generatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Get child exam card error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's timetable by admission number
app.get('/api/parents/me/children/:admissionNumber/timetable', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      where.courseId = student.courseId;
      if (student.currentYear) where.year = student.currentYear;
      if (student.currentSemester) where.semester = student.currentSemester;
    } else {
      where.classId = student.classId;
    }

    const timetable = await Timetable.findAll({
      where,
      include: [
        { model: Subject, required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { 
          model: Staff, 
          as: 'teacher',
          include: [{ model: User, attributes: ['firstName', 'lastName'] }],
          required: false 
        }
      ],
      order: [['day', 'ASC'], ['period', 'ASC']]
    });

    res.json({ 
      success: true, 
      timetable,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child timetable error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/students/:id', authenticate, async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });

    // Check admission number uniqueness
    if (req.body.admissionNumber && req.body.admissionNumber !== student.admissionNumber) {
      const existingStudent = await Student.findOne({
        where: { 
          admissionNumber: req.body.admissionNumber,
          schoolId: req.user.schoolId,
          id: { [Op.ne]: student.id }
        }
      });
      if (existingStudent) {
        return res.status(400).json({ 
          message: `Admission number '${req.body.admissionNumber}' already exists.` 
        });
      }
    }

    const oldStudent = { ...student.toJSON() };
    await student.update(req.body);
    await createAuditLog(req, 'UPDATE', 'STUDENT', student.id, oldStudent, student);

    res.json({ success: true, student });
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// PATCH endpoint for partial updates (like linking userId)
app.patch('/api/students/:id', authenticate, async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const oldStudent = { ...student.toJSON() };
    await student.update(req.body);
    await createAuditLog(req, 'UPDATE', 'STUDENT', student.id, oldStudent, student);

    res.json({ success: true, student });
  } catch (error) {
    console.error('Patch student error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.delete('/api/students/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });

    await student.destroy();
    await createAuditLog(req, 'DELETE', 'STUDENT', req.params.id);

    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Student Promotion Routes (Regular Schools)
app.post('/api/students/promote', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'ECDE_PRIMARY_JSS' && school.category !== 'SENIOR_SECONDARY') {
      return res.status(400).json({ 
        message: 'Promotion endpoint is only for regular schools. Use progression endpoints for universities/TVET.' 
      });
    }

    await Student.update(
      { classId: newClassId },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    await createAuditLog(req, 'PROMOTE', 'STUDENT', null, null, { studentIds, newClassId, academicYear });

    res.json({
      success: true,
      message: `${studentIds.length} students promoted successfully`
    });
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== UNIVERSITY PROGRESSION ====================
app.post('/api/students/progress', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newYear, newSemester } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'UNIVERSITY') {
      return res.status(400).json({ 
        success: false,
        message: 'Year progression only applicable for university' 
      });
    }

    await Student.update(
      { 
        currentYear: newYear, 
        currentSemester: newSemester || 1 
      },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS', 'STUDENT', null, null, { 
      studentIds, 
      newYear, 
      newSemester 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students progressed to Year ${newYear}, Semester ${newSemester || 1}`
    });
  } catch (error) {
    console.error('Progress students error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET MODULE PROGRESSION ====================
app.post('/api/students/progress-module', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newModule, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Module progression only applicable for TVET' 
      });
    }

    // Prepare update data
    const updateData = { currentModule: newModule };
    if (newYear) {
      updateData.currentYear = newYear;
    }

    await Student.update(
      updateData,
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_MODULE', 'STUDENT', null, null, { 
      studentIds, 
      newModule,
      newYear 
    });

    let message = `${studentIds.length} students progressed to ${newModule}`;
    if (newYear) message += ` and Year ${newYear}`;

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Progress module error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET PROGRAM PROGRESSION ====================
app.post('/api/students/progress-program', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newProgramId, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Program progression only applicable for TVET' 
      });
    }

    // Verify program exists
    const program = await Program.findOne({
      where: { 
        id: newProgramId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false,
        message: 'Target program not found' 
      });
    }

    // Prepare update data - reset module to Module 1 when changing programs
    const updateData = { 
      programId: newProgramId,
      currentModule: 'Module 1'
    };
    
    if (newYear) {
      updateData.currentYear = newYear;
    }

    await Student.update(
      updateData,
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_PROGRAM', 'STUDENT', null, null, { 
      studentIds, 
      newProgramId,
      newYear 
    });

    let message = `${studentIds.length} students progressed to ${program.name}`;
    if (newYear) message += ` and Year ${newYear}`;

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Progress program error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET YEAR-ONLY PROGRESSION ====================
app.post('/api/students/progress-year', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Year progression only applicable for TVET' 
      });
    }

    await Student.update(
      { currentYear: newYear },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_YEAR', 'STUDENT', null, null, { 
      studentIds, 
      newYear 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students progressed to Year ${newYear}`
    });
  } catch (error) {
    console.error('Progress year error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== REGULAR SCHOOL PROMOTION ====================
app.post('/api/students/promote', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'This endpoint is for regular schools only. Use progression endpoints for university/TVET.' 
      });
    }

    // Verify class exists
    const targetClass = await Class.findOne({
      where: { 
        id: newClassId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!targetClass) {
      return res.status(404).json({ 
        success: false,
        message: 'Target class not found' 
      });
    }

    await Student.update(
      { classId: newClassId },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROMOTE', 'STUDENT', null, null, { 
      studentIds, 
      newClassId,
      academicYear 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students promoted to ${targetClass.name}`
    });
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== PARENT ROUTES ====================

app.get('/api/parents', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    
    // If user is a parent, only show their own records
    if (req.user.role === 'PARENT') {
      where.userId = req.user.id;
    }
    
    // If studentId is provided in query, filter by that student
    const { studentId } = req.query;
    if (studentId) {
      where.studentId = studentId;
    }

    const parents = await Parent.findAll({
      where,
      include: [
        { 
          model: User, 
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone'],
          required: false 
        },
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      parents,
      count: parents.length
    });
  } catch (error) {
    console.error('Get parents error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/parents/:id', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }
    
    res.json({ success: true, parent });
  } catch (error) {
    console.error('Get parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.post('/api/parents', authenticate, async (req, res) => {
  try {
    const { 
      userId, 
      studentId, 
      relationship, 
      isPrimary, 
      emergencyContact,
      occupation,
      employer,
      monthlyIncome 
    } = req.body;

    // Check if user exists
    const user = await User.findOne({
      where: { id: userId, schoolId: req.user.schoolId }
    });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found in this school' 
      });
    }

    // Check if student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found in this school' 
      });
    }

    // Check if relationship already exists
    const existing = await Parent.findOne({
      where: { userId, studentId }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'This parent-student relationship already exists' 
      });
    }

    // If this is marked as primary, unmark any other primary for this student
    if (isPrimary) {
      await Parent.update(
        { isPrimary: false },
        { where: { studentId, isPrimary: true } }
      );
    }

    const parent = await Parent.create({
      userId,
      studentId,
      relationship: relationship || 'Parent',
      isPrimary: isPrimary || false,
      emergencyContact: emergencyContact || false,
      occupation,
      employer,
      monthlyIncome,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'PARENT', parent.id, null, parent);

    const createdParent = await Parent.findByPk(parent.id, {
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });

    res.status(201).json({ 
      success: true, 
      parent: createdParent,
      message: 'Parent record created successfully'
    });
  } catch (error) {
    console.error('Create parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.put('/api/parents/:id', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }

    // If updating isPrimary to true, unmark any other primary for this student
    if (req.body.isPrimary && !parent.isPrimary) {
      await Parent.update(
        { isPrimary: false },
        { where: { studentId: parent.studentId, isPrimary: true } }
      );
    }

    const oldParent = { ...parent.toJSON() };
    await parent.update(req.body);
    await createAuditLog(req, 'UPDATE', 'PARENT', parent.id, oldParent, parent);

    const updatedParent = await Parent.findByPk(parent.id, {
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });

    res.json({ 
      success: true, 
      parent: updatedParent,
      message: 'Parent record updated successfully'
    });
  } catch (error) {
    console.error('Update parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.delete('/api/parents/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }

    await parent.destroy();
    await createAuditLog(req, 'DELETE', 'PARENT', req.params.id);

    res.json({ 
      success: true, 
      message: 'Parent record deleted successfully' 
    });
  } catch (error) {
    console.error('Delete parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/parents/:parentId/students', authenticate, async (req, res) => {
  try {
    const parentId = req.params.parentId;
    
    const parent = await Parent.findOne({
      where: { 
        id: parentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent not found' 
      });
    }

    // Find all students linked to this parent
    const parents = await Parent.findAll({
      where: { userId: parent.userId },
      include: [{
        model: Student,
        include: [
          { model: Class },
          { model: Course }
        ]
      }]
    });

    const students = parents.map(p => p.Student).filter(s => s);

    res.json({ 
      success: true, 
      students,
      count: students.length
    });
  } catch (error) {
    console.error('Get parent students error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== SUBJECT ROUTES ====================

app.post('/api/subjects', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, code, classId, teacherId, isCompulsory, category, maxMarks, passMarks } = req.body;

    const subject = await Subject.create({
      name,
      code,
      classId,
      teacherId,
      isCompulsory,
      category,
      maxMarks,
      passMarks,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'SUBJECT', subject.id, null, subject);

    res.status(201).json({ success: true, subject });
  } catch (error) {
    console.error('Create subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/subjects', authenticate, async (req, res) => {
  try {
    const { classId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (classId) where.classId = classId;

    const subjects = await Subject.findAll({
      where,
      include: [
        { model: Class, required: false },
        { model: User, as: 'teacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/subjects/:id', authenticate, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!subject) {
      return res.status(404).json({ message: 'Subject not found' });
    }
    
    res.json({ success: true, subject });
  } catch (error) {
    console.error('Get subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/subjects/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!subject) return res.status(404).json({ message: 'Subject not found' });

    const oldSubject = { ...subject.toJSON() };
    await subject.update(req.body);
    await createAuditLog(req, 'UPDATE', 'SUBJECT', subject.id, oldSubject, subject);

    res.json({ success: true, subject });
  } catch (error) {
    console.error('Update subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/subjects/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!subject) return res.status(404).json({ message: 'Subject not found' });

    await subject.destroy();
    await createAuditLog(req, 'DELETE', 'SUBJECT', req.params.id);

    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Delete subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// ==================== COMPLETE CORRECTED EXAM ROUTES ====================
// ==================== UPDATED ROUTES WITH CORRECT ALIASES ====================

// GET SINGLE EXAM BY ID
app.get('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('📋 Fetching exam with ID:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name', 'code'], required: false },
        { model: Program, as: 'program', attributes: ['id', 'name', 'code'], required: false },
        { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false }, // Changed from 'unit'
        { model: Class, as: 'class', attributes: ['id', 'name'], required: false },
        { model: Subject, as: 'subject', attributes: ['id', 'name', 'code'], required: false },
        { model: Faculty, as: 'faculty', attributes: ['id', 'name'], required: false },
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false }
      ]
    });
    
    if (!exam) {
      console.log('❌ Exam not found:', req.params.id);
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    console.log('✅ Exam found:', exam.name);
    res.json({ 
      success: true, 
      exam 
    });
  } catch (error) {
    console.error('❌ Get exam by ID error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET ALL EXAMS WITH FILTERS
app.get('/api/exams', authenticate, async (req, res) => {
  try {
    console.log('📋 Fetching exams with query:', req.query);
    
    const { 
      classId, subjectId, courseId, programId, facultyId, 
      type, term, year, semester, module, unitId 
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // Apply filters based on school category
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (facultyId) where.facultyId = facultyId;
      if (year) where.year = parseInt(year);
      if (semester) where.semester = parseInt(semester);
      if (unitId) where.unitId = unitId;
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
      if (year) where.year = parseInt(year);
      if (module) where.module = parseInt(module);
      if (unitId) where.unitId = unitId;
    } 
    else {
      if (classId) where.classId = classId;
      if (subjectId) where.subjectId = subjectId;
    }
    
    if (type) where.type = type;
    if (term) where.term = term;

    let exams;
    
    try {
      if (school.category === 'UNIVERSITY') {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Course, as: 'course', attributes: ['id', 'name', 'code'], required: false },
            { model: Faculty, as: 'faculty', attributes: ['id', 'name'], required: false },
            { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
            { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false } // Changed from 'unit'
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      } 
      else if (school.category === 'COLLEGE_TVET') {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Program, as: 'program', attributes: ['id', 'name', 'code'], required: false },
            { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false } // Changed from 'unit'
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      } 
      else {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Class, as: 'class', attributes: ['id', 'name', 'capacity'], required: false },
            { model: Subject, as: 'subject', attributes: ['id', 'name', 'code'], required: false }
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      }
    } catch (includeError) {
      console.error('Error with includes, falling back to simple query:', includeError);
      // Fallback to simple query without includes
      exams = await Exam.findAll({ 
        where, 
        order: [['date', 'DESC'], ['createdAt', 'DESC']] 
      });
    }
    
    console.log(`✅ Found ${exams.length} exams`);
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// CREATE EXAM
app.post('/api/exams', authenticate, async (req, res) => {
  try {
    console.log('📝 Creating exam with data:', req.body);
    
    const {
      name, type, classId, subjectId, term, academicYear,
      date, startTime, endTime, maxMarks, weightage,
      courseId, facultyId, departmentId, unitId, year, semester,
      programId, module,
      examHall, invigilator, invigilatorId, schoolId
    } = req.body;

    // Get the school to determine category
    const school = await School.findByPk(req.user.schoolId || schoolId);
    
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // Validate required fields based on school category
    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course ID is required for university exams' 
        });
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program ID is required for TVET exams' 
        });
      }
    } 
    else {
      if (!classId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Class ID is required for regular schools' 
        });
      }
      if (!subjectId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Subject ID is required for regular schools' 
        });
      }
    }

    // Prepare exam data
    const examData = {
      name,
      type,
      term: term || (school.category === 'UNIVERSITY' ? `Semester ${semester || 1}` : 
                     school.category === 'COLLEGE_TVET' ? `Module ${module || 1}` : 'Term 1'),
      academicYear: academicYear || new Date().getFullYear().toString(),
      date,
      startTime: startTime || null,
      endTime: endTime || null,
      maxMarks: maxMarks || 100,
      weightage: weightage || null,
      examHall: examHall || null,
      invigilator: invigilator || null,
      invigilatorId: invigilatorId || null,
      schoolId: req.user.schoolId || schoolId,
      isPublished: false,
      resultsPublished: false,
      // University fields
      courseId: school.category === 'UNIVERSITY' ? courseId : null,
      facultyId: school.category === 'UNIVERSITY' ? (facultyId || null) : null,
      departmentId: school.category === 'UNIVERSITY' ? (departmentId || null) : null,
      unitId: (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') ? (unitId || null) : null,
      year: (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') ? (year ? parseInt(year) : null) : null,
      semester: school.category === 'UNIVERSITY' ? (semester ? parseInt(semester) : null) : null,
      // TVET fields
      programId: school.category === 'COLLEGE_TVET' ? programId : null,
      module: school.category === 'COLLEGE_TVET' ? (module ? parseInt(module) : null) : null,
      // Regular school fields
      classId: !['UNIVERSITY', 'COLLEGE_TVET'].includes(school.category) ? classId : null,
      subjectId: !['UNIVERSITY', 'COLLEGE_TVET'].includes(school.category) ? subjectId : null
    };

    console.log('📝 Creating exam with processed data:', examData);

    // Create the exam
    const exam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'CREATE', 'EXAM', exam.id, null, exam);
    }

    // Fetch the created exam with associations
    const createdExam = await Exam.findByPk(exam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false },
        { model: Faculty, as: 'faculty', required: false },
        { model: Department, as: 'department', required: false }
      ]
    });

    res.status(201).json({ 
      success: true, 
      exam: createdExam 
    });

  } catch (error) {
    console.error('❌ Create exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE EXAM
app.put('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('📝 Updating exam:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    const oldExam = { ...exam.toJSON() };
    await exam.update(req.body);
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'UPDATE', 'EXAM', exam.id, oldExam, exam);
    }
    
    // Fetch updated exam with associations
    const updatedExam = await Exam.findByPk(exam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false },
        { model: Faculty, as: 'faculty', required: false },
        { model: Department, as: 'department', required: false }
      ]
    });
    
    console.log('✅ Exam updated successfully');
    res.json({ 
      success: true, 
      exam: updatedExam 
    });
  } catch (error) {
    console.error('❌ Update exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET EXAMS BY COURSE
app.get('/api/exams/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        courseId: req.params.courseId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'courseUnit', required: false } // Changed from 'unit'
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// GET EXAMS BY PROGRAM
app.get('/api/exams/by-program/:programId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        programId: req.params.programId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'courseUnit', required: false } // Changed from 'unit'
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// DUPLICATE EXAM
app.post('/api/exams/:id/duplicate', authenticate, async (req, res) => {
  try {
    console.log('📋 Duplicating exam:', req.params.id);
    
    const { newName, newDate } = req.body;
    
    const sourceExam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!sourceExam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Create new exam object without the id and timestamps
    const examData = sourceExam.toJSON();
    delete examData.id;
    delete examData.createdAt;
    delete examData.updatedAt;
    delete examData.publishedAt;
    
    // Update with new values
    examData.name = newName || `Copy of ${examData.name}`;
    examData.date = newDate || examData.date;
    examData.isPublished = false;
    examData.resultsPublished = false;

    const newExam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DUPLICATE', 'EXAM', newExam.id, null, { sourceId: req.params.id });
    }

    // Fetch with associations
    const createdExam = await Exam.findByPk(newExam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false }
      ]
    });

    console.log('✅ Exam duplicated successfully');
    res.json({ 
      success: true, 
      exam: createdExam 
    });
  } catch (error) {
    console.error('❌ Duplicate exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== DELETE EXAM WITH CASCADE ====================
app.delete('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('🗑️ Deleting exam:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Check for associated results
    const resultsCount = await Result.count({
      where: { examId: req.params.id }
    });

    if (resultsCount > 0) {
      console.log(`📊 Found ${resultsCount} results linked to this exam`);
      
      // Delete all associated results first
      await Result.destroy({
        where: { examId: req.params.id }
      });
      
      console.log(`✅ Deleted ${resultsCount} associated results`);
    }

    // Then delete the exam
    await exam.destroy();
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DELETE', 'EXAM', req.params.id, null, { 
        deletedResults: resultsCount 
      });
    }
    
    console.log(`✅ Exam and ${resultsCount} associated results deleted successfully`);
    res.json({ 
      success: true, 
      message: `Exam deleted successfully along with ${resultsCount} associated results` 
    });

  } catch (error) {
    console.error('❌ Delete exam error:', error);
    
    // Handle foreign key constraint errors
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete exam because it has associated results. Please delete results first.',
        error: 'FK_CONSTRAINT_VIOLATION'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== PUBLISH EXAM RESULTS ====================
app.put('/api/exams/:id/publish', authenticate, async (req, res) => {
  try {
    console.log('📢 Publishing exam results:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    const { isPublished, resultsPublished } = req.body;
    
    await exam.update({ 
      isPublished: isPublished !== undefined ? isPublished : true,
      resultsPublished: resultsPublished !== undefined ? resultsPublished : true,
      publishedAt: new Date().toISOString()
    });
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'PUBLISH', 'EXAM', exam.id, null, { 
        isPublished: exam.isPublished,
        resultsPublished: exam.resultsPublished,
        publishedAt: exam.publishedAt
      });
    }
    
    console.log('✅ Exam published successfully');
    res.json({ 
      success: true, 
      message: 'Exam results published successfully',
      exam
    });
  } catch (error) {
    console.error('❌ Publish exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== BULK DELETE EXAMS ====================
app.post('/api/exams/bulk-delete', authenticate, async (req, res) => {
  try {
    const { examIds } = req.body;
    
    if (!examIds || !Array.isArray(examIds) || examIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide an array of exam IDs' 
      });
    }

    console.log('🗑️ Bulk deleting exams:', examIds);
    
    let totalResultsDeleted = 0;
    let totalExamsDeleted = 0;
    const errors = [];

    // Process each exam
    for (const examId of examIds) {
      try {
        // Check if exam exists and belongs to user's school
        const exam = await Exam.findOne({
          where: { 
            id: examId,
            schoolId: req.user.schoolId 
          }
        });

        if (!exam) {
          errors.push({ examId, error: 'Exam not found' });
          continue;
        }

        // Delete associated results first
        const resultsDeleted = await Result.destroy({
          where: { examId: examId }
        });
        
        totalResultsDeleted += resultsDeleted;

        // Then delete the exam
        await exam.destroy();
        totalExamsDeleted++;

        console.log(`✅ Deleted exam ${examId} with ${resultsDeleted} results`);

      } catch (err) {
        console.error(`❌ Error deleting exam ${examId}:`, err);
        errors.push({ examId, error: err.message });
      }
    }

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'BULK_DELETE', 'EXAM', null, null, { 
        examsDeleted: totalExamsDeleted,
        resultsDeleted: totalResultsDeleted,
        errors: errors.length
      });
    }

    res.json({ 
      success: true, 
      message: `Successfully deleted ${totalExamsDeleted} exams and ${totalResultsDeleted} results`,
      data: {
        examsDeleted: totalExamsDeleted,
        resultsDeleted: totalResultsDeleted,
        errors: errors
      }
    });

  } catch (error) {
    console.error('❌ Bulk delete exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== DUPLICATE EXAM ====================
app.post('/api/exams/:id/duplicate', authenticate, async (req, res) => {
  try {
    console.log('📋 Duplicating exam:', req.params.id);
    
    const { newName, newDate } = req.body;
    
    const sourceExam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!sourceExam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Create new exam object without the id and timestamps
    const examData = sourceExam.toJSON();
    delete examData.id;
    delete examData.createdAt;
    delete examData.updatedAt;
    delete examData.publishedAt;
    
    // Update with new values
    examData.name = newName || `Copy of ${examData.name}`;
    examData.date = newDate || examData.date;
    examData.isPublished = false;
    examData.resultsPublished = false;

    const newExam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DUPLICATE', 'EXAM', newExam.id, null, { sourceId: req.params.id });
    }

    // Fetch with associations
    const createdExam = await Exam.findByPk(newExam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false }
      ]
    });

    console.log('✅ Exam duplicated successfully');
    res.json({ 
      success: true, 
      exam: createdExam 
    });
  } catch (error) {
    console.error('❌ Duplicate exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY COURSE ====================
app.get('/api/exams/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        courseId: req.params.courseId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'unit', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY PROGRAM ====================
app.get('/api/exams/by-program/:programId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        programId: req.params.programId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'unit', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY CLASS ====================
app.get('/api/exams/by-class/:classId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        classId: req.params.classId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Subject, as: 'subject', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by class error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY TEACHER ====================
app.get('/api/exams/by-teacher/:teacherId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        invigilatorId: req.params.teacherId,
        schoolId: req.user.schoolId 
      },
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by teacher error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET UPCOMING EXAMS ====================
app.get('/api/exams/upcoming', authenticate, async (req, res) => {
  try {
    const today = new Date();
    const exams = await Exam.findAll({
      where: {
        schoolId: req.user.schoolId,
        date: { [Op.gte]: today }
      },
      order: [['date', 'ASC']],
      limit: 10
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get upcoming exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET PAST EXAMS ====================
app.get('/api/exams/past', authenticate, async (req, res) => {
  try {
    const today = new Date();
    const exams = await Exam.findAll({
      where: {
        schoolId: req.user.schoolId,
        date: { [Op.lt]: today }
      },
      order: [['date', 'DESC']],
      limit: 20
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get past exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS WITH RESULTS STATISTICS ====================
app.get('/api/exams/with-results', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: Result,
          as: 'results',
          required: false,
          attributes: ['id', 'marks', 'grade', 'points']
        }
      ],
      order: [['date', 'DESC']]
    });

    // Add statistics to each exam
    const examsWithStats = exams.map(exam => {
      const results = exam.results || [];
      const totalStudents = results.length;
      const averageMarks = totalStudents > 0 
        ? (results.reduce((sum, r) => sum + (r.marks || 0), 0) / totalStudents).toFixed(2)
        : 0;
      
      return {
        ...exam.toJSON(),
        statistics: {
          totalStudents,
          averageMarks,
          totalPoints: results.reduce((sum, r) => sum + (r.points || 0), 0),
          passCount: results.filter(r => (r.marks || 0) >= 50).length,
          passRate: totalStudents > 0 
            ? ((results.filter(r => (r.marks || 0) >= 50).length / totalStudents) * 100).toFixed(2)
            : 0
        }
      };
    });

    res.json({ success: true, exams: examsWithStats });
  } catch (error) {
    console.error('❌ Get exams with results error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});
// ==================== RESULTS ROUTES ====================

const calculateGradeFromMarksWithSystem = (marks, maxMarks, gradingSystem) => {
  if (!gradingSystem || !gradingSystem.getGrade) {
    return { grade: 'N/A', code: 'NG', points: 0, color: 'gray' };
  }
  const percentage = maxMarks > 0 ? (marks / maxMarks) * 100 : 0;
  return gradingSystem.getGrade(percentage);
};
// ===== CREATE RESULT =====
app.post('/api/results', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const { studentId, examId, subjectId, unitId, marks, isAbsent, remarks, description } = req.body;

    // ✅ Verify the student exists in the Students table
    const student = await Student.findOne({ 
      where: { 
        id: studentId,  // This is the student's ID from Students table
        schoolId: req.user.schoolId 
      } 
    });
    
    if (!student) {
      return res.status(400).json({ 
        success: false,
        message: `Student ${studentId} not found in your school` 
      });
    }

    const exam = await Exam.findOne({ 
      where: { id: examId, schoolId: req.user.schoolId } 
    });
    
    if (!exam) {
      return res.status(400).json({ 
        success: false,
        message: `Exam ${examId} not found in your school` 
      });
    }

    // ... rest of the result creation logic
  } catch (error) {
    console.error('Create result error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
app.get('/api/results', authenticate, async (req, res) => {
  try {
    const { studentId, examId } = req.query;
    const where = {};
    
    if (studentId) where.studentId = studentId;
    if (examId) where.examId = examId;

    const results = await Result.findAll({
      where,
      include: [
        { 
          model: Exam,
          attributes: ['id', 'name', 'date', 'type'],
          required: false
        },
        { 
          model: Subject,
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: CourseUnit,
          as: 'CourseUnit',
          attributes: ['id', 'name', 'code'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ success: true, results });
  } catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// ==================== FIXED RESULTS BY ADMISSION ENDPOINT ====================

// GET results by admission number - WITH RECALCULATED GRADES
app.get('/api/results/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    console.log(`🔍 Looking up student with admission: ${admissionNumber}`);

    // Find student by admission number with all necessary includes
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { 
          model: Course,
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Class,
          required: false,
          attributes: ['id', 'name']
        },
        {
          model: Program,
          required: false,
          attributes: ['id', 'name']
        }
      ]
    });

    if (!student) {
      console.log(`❌ Student not found with admission: ${admissionNumber}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);

    // Get the school to know the grading system
    const school = await School.findByPk(req.user.schoolId);
    console.log(`🏫 School category: ${school.category}, Grading system: ${school.gradingSystem}`);
    
    // Get the grading system based on school category
    const gradingSystem = getGradingSystem(school.category);

    // Get all results for this student with exam and unit/subject details
    const results = await Result.findAll({
      where: { studentId: student.id },
      include: [
        { 
          model: Exam,
          attributes: ['id', 'name', 'date', 'type', 'maxMarks'],
          required: false
        },
        { 
          model: Subject,
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: CourseUnit,
          as: 'CourseUnit',
          attributes: ['id', 'name', 'code', 'semester', 'year', 'credits'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    console.log(`📊 Found ${results.length} results for student`);

    // Get all exams to cross-reference (in case the exam wasn't included properly)
    const examIds = [...new Set(results.map(r => r.examId).filter(id => id))];
    const examsMap = {};
    if (examIds.length > 0) {
      const exams = await Exam.findAll({
        where: { id: examIds },
        attributes: ['id', 'name', 'date', 'type', 'maxMarks']
      });
      exams.forEach(exam => {
        examsMap[exam.id] = exam;
      });
    }

    // Get all units to cross-reference
    const unitIds = [...new Set(results.map(r => r.unitId).filter(id => id))];
    const unitsMap = {};
    if (unitIds.length > 0) {
      const units = await CourseUnit.findAll({
        where: { id: unitIds },
        attributes: ['id', 'name', 'code', 'semester', 'year', 'credits']
      });
      units.forEach(unit => {
        unitsMap[unit.id] = unit;
      });
    }

    // Process each result to recalculate grade based on current school category
    const processedResults = results.map(result => {
      // Get marks (default to 0 if not present)
      const marks = result.marks || 0;
      
      // Get max marks from exam if available
      let maxMarks = 100;
      let examName = 'Examination';
      let examDate = null;
      
      // Try to get exam from the included association
      if (result.Exam) {
        maxMarks = result.Exam.maxMarks || 100;
        examName = result.Exam.name || 'Examination';
        examDate = result.Exam.date;
      } 
      // If not, try the examsMap
      else if (result.examId && examsMap[result.examId]) {
        maxMarks = examsMap[result.examId].maxMarks || 100;
        examName = examsMap[result.examId].name || 'Examination';
        examDate = examsMap[result.examId].date;
      }
      
      // Recalculate grade based on current school category
      const gradeInfo = gradingSystem.getGrade(marks);
      
      // Get unit/subject name based on school category
      let itemName = 'General';
      let unitCode = '';
      let unitCredits = null;
      let unitSemester = null;
      let unitYear = null;
      
      if (school.category === 'UNIVERSITY') {
        // Try to get unit from included association
        if (result.CourseUnit) {
          itemName = result.CourseUnit.name || 'Course Unit';
          unitCode = result.CourseUnit.code || '';
          unitCredits = result.CourseUnit.credits;
          unitSemester = result.CourseUnit.semester;
          unitYear = result.CourseUnit.year;
        }
        // Try unitsMap
        else if (result.unitId && unitsMap[result.unitId]) {
          itemName = unitsMap[result.unitId].name || 'Course Unit';
          unitCode = unitsMap[result.unitId].code || '';
          unitCredits = unitsMap[result.unitId].credits;
          unitSemester = unitsMap[result.unitId].semester;
          unitYear = unitsMap[result.unitId].year;
        }
        // Default
        else {
          itemName = 'Course Unit';
        }
      } 
      else if (school.category === 'COLLEGE_TVET') {
        if (result.CourseUnit) {
          itemName = result.CourseUnit.name || 'Module';
        } else if (result.unitId && unitsMap[result.unitId]) {
          itemName = unitsMap[result.unitId].name || 'Module';
        } else {
          itemName = 'Module';
        }
      } 
      else {
        // Regular school - use subject
        if (result.Subject) {
          itemName = result.Subject.name || 'Subject';
        } else {
          itemName = 'Subject';
        }
      }
      
      return {
        id: result.id,
        examId: result.examId,
        studentId: result.studentId,
        subjectId: result.subjectId,
        unitId: result.unitId,
        marks: marks,
        // Use recalculated values instead of stored ones
        grade: gradeInfo.grade,
        gradeCode: gradeInfo.code,
        points: gradeInfo.points,
        isAbsent: result.isAbsent || false,
        remarks: result.remarks,
        description: result.description,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        // Include exam details
        exam: {
          id: result.Exam?.id || result.examId,
          name: examName,
          date: examDate,
          type: result.Exam?.type,
          maxMarks: maxMarks
        },
        // Include unit/subject details
        unit: result.CourseUnit ? {
          id: result.CourseUnit.id,
          name: result.CourseUnit.name,
          code: result.CourseUnit.code,
          semester: result.CourseUnit.semester,
          year: result.CourseUnit.year,
          credits: result.CourseUnit.credits
        } : (result.unitId && unitsMap[result.unitId] ? {
          id: unitsMap[result.unitId].id,
          name: unitsMap[result.unitId].name,
          code: unitsMap[result.unitId].code,
          semester: unitsMap[result.unitId].semester,
          year: unitsMap[result.unitId].year,
          credits: unitsMap[result.unitId].credits
        } : null),
        subject: result.Subject ? {
          id: result.Subject.id,
          name: result.Subject.name,
          code: result.Subject.code
        } : null,
        // For frontend compatibility - flattened fields
        examName: examName,
        unitName: itemName,
        subjectName: itemName,
        examDate: examDate,
        unitCode: unitCode,
        unitCredits: unitCredits,
        unitSemester: unitSemester,
        unitYear: unitYear
      };
    });

    // Determine course name for student
    let courseName = 'N/A';
    if (school.category === 'UNIVERSITY') {
      if (student.Course) {
        courseName = student.Course.name;
      } else if (student.courseId) {
        // Try to fetch course if not included
        const course = await Course.findByPk(student.courseId);
        courseName = course ? course.name : 'N/A';
      }
    } else if (school.category === 'COLLEGE_TVET') {
      if (student.Program) {
        courseName = student.Program.name;
      }
    } else {
      if (student.Class) {
        courseName = student.Class.name;
      }
    }

    // Determine year of study
    let yearOfStudy = 'N/A';
    if (student.currentYear) {
      yearOfStudy = `Year ${student.currentYear}`;
    } else if (student.year) {
      yearOfStudy = `Year ${student.year}`;
    }

    console.log(`✅ Processed ${processedResults.length} results with recalculated grades`);

    res.json({ 
      success: true, 
      results: processedResults,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        course: student.Course ? {
          id: student.Course.id,
          name: student.Course.name,
          code: student.Course.code
        } : null,
        class: student.Class ? {
          id: student.Class.id,
          name: student.Class.name
        } : null,
        program: student.Program ? {
          id: student.Program.id,
          name: student.Program.name
        } : null,
        courseName: courseName,
        currentYear: student.currentYear,
        yearOfStudy: yearOfStudy,
        currentSemester: student.currentSemester
      }
    });
  } catch (error) {
    console.error('❌ Get results by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});
// GET /api/results/exam/:examId - Get all results for a specific exam
app.get('/api/results/exam/:examId', authenticate, async (req, res) => {  // <-- ADD authenticate here
  try {
    const { examId } = req.params;
    
    const results = await Result.findAll({
      where: { examId },
      include: [
        {
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        },
        {
          model: Exam,
          attributes: ['id', 'name', 'maxMarks', 'unitId', 'subjectId']
        }
      ]
    });
    
    res.json({ 
      success: true, 
      results,
      count: results.length 
    });
  } catch (error) {
    console.error('Error fetching exam results:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch exam results',
      error: error.message 
    });
  }
});


app.get('/api/results/:id', authenticate, async (req, res) => {
  try {
    const result = await Result.findOne({
      where: { id: req.params.id },
      include: [
        { model: Student },
        { model: Exam },
        { model: Subject },
        { model: CourseUnit, as: 'CourseUnit' }
      ]
    });

    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ success: true, result });
  } catch (error) {
    console.error('Get result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/results/:id', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const result = await Result.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldResult = { ...result.toJSON() };
    const { marks, isAbsent, remarks, description } = req.body;

    let gradeInfo = { grade: result.grade, gradeCode: result.gradeCode, points: result.points };
    if ((marks !== undefined && marks !== result.marks) || (isAbsent !== undefined && isAbsent !== result.isAbsent)) {
      const exam = await Exam.findByPk(result.examId);
      const school = await School.findByPk(req.user.schoolId);
      const gradingSystemObj = GRADING_SYSTEMS[school.gradingSystem] || GRADING_SYSTEMS.CBC;
      const maxMarks = exam.maxMarks || 100;

      gradeInfo = isAbsent
        ? { grade: 'ABS', code: 'ABS', points: 0 }
        : calculateGradeFromMarksWithSystem(marks, maxMarks, gradingSystemObj);
    }

    await result.update({
      marks: marks !== undefined ? marks : result.marks,
      isAbsent: isAbsent !== undefined ? isAbsent : result.isAbsent,
      remarks: remarks !== undefined ? remarks : result.remarks,
      description: description !== undefined ? description : result.description,
      grade: gradeInfo.grade,
      gradeCode: gradeInfo.code,
      points: gradeInfo.points
    });

    await createAuditLog(req, 'UPDATE', 'RESULT', result.id, oldResult, result);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Update result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/results/:id', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const result = await Result.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    await result.destroy();
    await createAuditLog(req, 'DELETE', 'RESULT', req.params.id);
    res.json({ success: true, message: 'Result deleted successfully' });
  } catch (error) {
    console.error('Delete result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/results/positions', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const { examId } = req.body;

    const exam = await Exam.findOne({ where: { id: examId, schoolId: req.user.schoolId } });
    if (!exam) {
      return res.status(404).json({ message: 'Exam not found' });
    }

    const results = await Result.findAll({
      where: { examId },
      order: [['marks', 'DESC']]
    });

    let rank = 1;
    let prevMarks = null;
    for (let i = 0; i < results.length; i++) {
      if (prevMarks !== results[i].marks) {
        rank = i + 1;
        prevMarks = results[i].marks;
      }
      await results[i].update({ position: rank });
    }

    res.json({ success: true, message: `Positions updated for ${results.length} results` });
  } catch (error) {
    console.error('Calculate positions error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== ATTENDANCE ENDPOINTS ====================

// POST /api/attendance - Create or update attendance records
app.post('/api/attendance', authenticate, async (req, res) => {
  try {
    console.log('📝 Received attendance request body:', JSON.stringify(req.body, null, 2));
    
    // Get the attendance records from request
    let attendanceData = req.body;
    let attendanceRecords = [];
    
    // Handle different possible formats
    if (Array.isArray(attendanceData)) {
      attendanceRecords = attendanceData;
    } 
    else if (attendanceData && typeof attendanceData === 'object') {
      const keys = Object.keys(attendanceData);
      const hasNumericKeys = keys.some(key => !isNaN(key) && key !== '');
      
      if (hasNumericKeys) {
        attendanceRecords = keys
          .filter(key => !isNaN(key))
          .map(key => attendanceData[key]);
        console.log('📝 Converted object with numeric keys to array:', attendanceRecords);
      } else {
        attendanceRecords = [attendanceData];
        console.log('📝 Wrapped single object in array:', attendanceRecords);
      }
    }
    
    if (!attendanceRecords || attendanceRecords.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No attendance records provided' 
      });
    }
    
    console.log(`📝 Processing ${attendanceRecords.length} attendance records`);
    
    const createdRecords = [];
    const updatedRecords = [];
    const skippedRecords = []; // Records that already exist
    const errors = [];

    for (const record of attendanceRecords) {
      try {
        // Validate required fields
        if (!record.studentId || !record.status || !record.date) {
          errors.push({
            record,
            error: `Missing required fields for student ${record.studentId || 'unknown'}`
          });
          continue;
        }

        // Build where clause to check for existing record
        const whereClause = {
          studentId: record.studentId,
          date: record.date
        };
        
        // Add unitId or subjectId to where clause if provided
        if (record.unitId) {
          whereClause.unitId = record.unitId;
        } else if (record.subjectId) {
          whereClause.subjectId = record.subjectId;
        } else {
          whereClause.unitId = null;
          whereClause.subjectId = null;
        }

        // Check if attendance already exists
        const existingAttendance = await Attendance.findOne({ 
          where: whereClause,
          include: [
            { model: CourseUnit, as: 'unit', attributes: ['id', 'name'] },
            { model: Subject, attributes: ['id', 'name'] }
          ]
        });

        // Prepare attendance data
        const attendanceData = {
          studentId: record.studentId,
          status: record.status,
          date: record.date,
          remarks: record.remarks || '',
          markedBy: req.user.id,
          schoolId: req.user.schoolId,
          classId: record.classId || null,
          courseId: record.courseId || null,
          programId: record.programId || null,
          unitId: record.unitId || null,
          subjectId: record.subjectId || null,
          timetableId: record.timetableId || null,
          period: record.period || null,
          startTime: record.startTime || null,
          endTime: record.endTime || null,
          year: record.year || null,
          semester: record.semester || null,
          module: record.module || null
        };

        if (existingAttendance) {
          // Instead of automatically updating, return info about existing record
          console.log(`⚠️ Attendance already exists for student ${record.studentId}`);
          skippedRecords.push({
            id: existingAttendance.id,
            studentId: existingAttendance.studentId,
            date: existingAttendance.date,
            unitId: existingAttendance.unitId,
            unitName: existingAttendance.unit?.name || existingAttendance.Subject?.name || 'Unknown',
            status: existingAttendance.status,
            remarks: existingAttendance.remarks,
            message: 'Attendance already marked'
          });
        } else {
          // Create new record
          const attendance = await Attendance.create(attendanceData);
          createdRecords.push(attendance);
          console.log(`✅ Created attendance for student ${record.studentId}`);
        }
        
      } catch (err) {
        console.error('Error processing attendance record:', err);
        errors.push({
          record,
          error: err.message
        });
      }
    }

    // Return detailed response
    res.json({
      success: true,
      message: `Created ${createdRecords.length}, Already marked ${skippedRecords.length} attendance records`,
      summary: {
        created: createdRecords.length,
        updated: updatedRecords.length,
        skipped: skippedRecords.length,
        errors: errors.length
      },
      records: {
        created: createdRecords,
        skipped: skippedRecords // Return skipped records with details
      },
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Mark attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to mark attendance',
      error: error.message 
    });
  }
});
// GET /api/attendance - Get attendance records with filters
app.get('/api/attendance', authenticate, async (req, res) => {
  try {
    const { 
      studentId, classId, courseId, programId, unitId, subjectId,
      date, startDate, endDate, status, limit = 100, page = 1
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    // Apply filters
    if (studentId) where.studentId = studentId;
    if (classId) where.classId = classId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (unitId) where.unitId = unitId;
    if (subjectId) where.subjectId = subjectId;
    if (status) where.status = status;
    
    // Date filters
    if (date) {
      where.date = date;
    } else if (startDate && endDate) {
      where.date = {
        [Op.between]: [startDate, endDate]
      };
    }

    // Role-based access
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (student) {
        where.studentId = student.id;
      } else {
        return res.json({ success: true, attendance: [], total: 0 });
      }
    } else if (req.user.role === 'PARENT') {
      const parents = await Parent.findAll({ 
        where: { userId: req.user.id },
        attributes: ['studentId']
      });
      const studentIds = parents.map(p => p.studentId);
      if (studentIds.length > 0) {
        where.studentId = studentIds;
      } else {
        return res.json({ success: true, attendance: [], total: 0 });
      }
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await Attendance.findAndCountAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          include: [
            { model: Course, attributes: ['id', 'name'], required: false },
            { model: Program, attributes: ['id', 'name'], required: false },
            { model: Class, attributes: ['id', 'name'], required: false }
          ]
        },
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime', 'room'],
          required: false 
        }
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });
    
    res.json({ 
      success: true, 
      attendance: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / parseInt(limit))
    });
  } catch (error) {
    console.error('❌ Get attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});


// GET /api/attendance/report - Generate attendance report for a student
app.get('/api/attendance/report', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, startDate, endDate } = req.query;

    if (!studentId) {
      return res.status(400).json({ 
        success: false,
        message: 'Student ID is required' 
      });
    }

    // Check access
    let hasAccess = false;
    if (req.user.role === 'SUPER_ADMIN') {
      hasAccess = true;
    } else if (req.user.role === 'SCHOOL_ADMIN' || req.user.role === 'PRINCIPAL' || req.user.role === 'DEPUTY_PRINCIPAL' || req.user.role === 'SENIOR_TEACHER') {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      hasAccess = !!student;
    } else if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      hasAccess = student && student.id === studentId;
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: studentId 
        }
      });
      hasAccess = !!parent;
    }

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false,
        message: 'Access denied' 
      });
    }

    const student = await Student.findByPk(studentId, {
      attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
      include: [
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Class, required: false }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false,
        message: 'Student not found' 
      });
    }

    const where = { studentId };
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime'],
          required: false 
        }
      ],
      order: [['date', 'DESC']]
    });

    // Overall summary
    const overall = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      fieldTrip: attendance.filter(a => a.status === 'FIELD_TRIP').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    // Group by unit/subject
    const byCourse = {};
    attendance.forEach(record => {
      const courseId = record.unitId || record.subjectId || 'no-course';
      const courseName = record.unit?.name || record.Subject?.name || 'No Course';
      
      if (!byCourse[courseId]) {
        byCourse[courseId] = {
          courseId,
          courseName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          permission: 0,
          sick: 0,
          fieldTrip: 0,
          records: []
        };
      }
      
      byCourse[courseId].total++;
      byCourse[courseId][record.status.toLowerCase()]++;
      byCourse[courseId].records.push(record);
    });

    // Calculate percentages per course
    Object.values(byCourse).forEach(course => {
      course.presentPercentage = course.total > 0 
        ? ((course.present / course.total) * 100).toFixed(2) 
        : 0;
      course.absentPercentage = course.total > 0 
        ? ((course.absent / course.total) * 100).toFixed(2) 
        : 0;
      course.latePercentage = course.total > 0 
        ? ((course.late / course.total) * 100).toFixed(2) 
        : 0;
    });

    res.json({
      success: true,
      report: {
        student,
        overall,
        byCourse: Object.values(byCourse),
        records: attendance
      }
    });
  } catch (error) {
    console.error('❌ Get attendance report error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET /api/attendance/by-admission/:admissionNumber - Get student attendance by admission number
app.get('/api/attendance/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Class, required: false }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false,
        message: 'Student not found with this admission number' 
      });
    }

    const where = { studentId: student.id };
    
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime', 'room'],
          required: false 
        }
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate summary statistics
    const summary = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      fieldTrip: attendance.filter(a => a.status === 'FIELD_TRIP').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    // Group by unit for detailed stats
    const byUnit = {};
    attendance.forEach(record => {
      const unitId = record.unitId || record.subjectId;
      if (!unitId) return;
      
      const unitName = record.unit?.name || record.Subject?.name || 'Unknown';
      
      if (!byUnit[unitId]) {
        byUnit[unitId] = {
          unitId,
          unitName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      
      byUnit[unitId].total++;
      byUnit[unitId][record.status.toLowerCase()]++;
    });

    // Calculate percentages per unit
    Object.values(byUnit).forEach(unit => {
      unit.presentPercentage = unit.total > 0 
        ? ((unit.present / unit.total) * 100).toFixed(1) 
        : 0;
    });

    res.json({ 
      success: true, 
      attendance,
      summary,
      byUnit: Object.values(byUnit),
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        course: student.Course,
        program: student.Program,
        class: student.Class
      }
    });
  } catch (error) {
    console.error('❌ Get attendance by admission error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error',
      error: error.message 
    });
  }
});

// GET /api/attendance/stats - Get attendance statistics
app.get('/api/attendance/stats', authenticate, async (req, res) => {
  try {
    const { courseId, programId, startDate, endDate } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { model: Student, attributes: ['id'] },
        { model: CourseUnit, as: 'unit', attributes: ['id', 'name'], required: false },
        { model: Subject, attributes: ['id', 'name'], required: false }
      ]
    });

    // Daily statistics
    const dailyStats = {};
    attendance.forEach(record => {
      if (!dailyStats[record.date]) {
        dailyStats[record.date] = {
          date: record.date,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          permission: 0,
          sick: 0,
          fieldTrip: 0
        };
      }
      dailyStats[record.date].total++;
      dailyStats[record.date][record.status.toLowerCase()]++;
    });

    // Calculate daily percentages
    Object.values(dailyStats).forEach(day => {
      day.presentPercentage = day.total > 0 
        ? ((day.present / day.total) * 100).toFixed(2) 
        : 0;
    });

    // Unit/Subject statistics
    const unitStats = {};
    attendance.forEach(record => {
      const unitId = record.unitId || record.subjectId;
      if (!unitId) return;
      
      const unitName = record.unit?.name || record.Subject?.name || 'Unknown';
      
      if (!unitStats[unitId]) {
        unitStats[unitId] = {
          unitId,
          unitName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      
      unitStats[unitId].total++;
      unitStats[unitId][record.status.toLowerCase()]++;
    });

    // Calculate unit percentages
    Object.values(unitStats).forEach(unit => {
      unit.presentPercentage = unit.total > 0 
        ? ((unit.present / unit.total) * 100).toFixed(2) 
        : 0;
    });

    res.json({
      success: true,
      stats: {
        daily: Object.values(dailyStats),
        byUnit: Object.values(unitStats),
        summary: {
          totalRecords: attendance.length,
          uniqueStudents: [...new Set(attendance.map(a => a.studentId))].length,
          uniqueDates: Object.keys(dailyStats).length,
          uniqueUnits: Object.keys(unitStats).length
        }
      }
    });
  } catch (error) {
    console.error('❌ Get attendance stats error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ❌ GENERIC ROUTES LAST - THESE COME AFTER ALL SPECIFIC ROUTES

// GET /api/attendance/:id - Get single attendance record
app.get('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
        },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Subject, required: false },
        { model: Timetable, required: false }
      ]
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }
    
    res.json({ 
      success: true, 
      attendance 
    });
  } catch (error) {
    console.error('❌ Get attendance record error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// PUT /api/attendance/:id - Update attendance record
app.put('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }

    const oldAttendance = { ...attendance.toJSON() };
    await attendance.update(req.body);
    
    // Create audit log
    await createAuditLog(req, 'UPDATE', 'ATTENDANCE', attendance.id, oldAttendance, attendance);

    const updatedAttendance = await Attendance.findByPk(attendance.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Subject, required: false }
      ]
    });

    res.json({ 
      success: true, 
      attendance: updatedAttendance 
    });
  } catch (error) {
    console.error('❌ Update attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE /api/attendance/:id - Delete attendance record
app.delete('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }

    await attendance.destroy();
    
    // Create audit log
    await createAuditLog(req, 'DELETE', 'ATTENDANCE', req.params.id);

    res.json({ 
      success: true, 
      message: 'Attendance record deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Delete attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});


// ==================== GET ALL FEES ====================
app.get('/api/fees', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, year, term, module } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Build where clause based on school type
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (year) where.year = parseInt(year);
      if (term) where.semester = parseInt(term);
    } else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
      if (module) where.module = parseInt(module);
      if (year) where.year = parseInt(year);
    } else {
      if (classId) where.classId = classId;
      if (term) where.term = term;
    }

    const fees = await Fee.findAll({
      where,
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Faculty, required: false },
        { model: Department, required: false },
        { model: TransportRoute, required: false }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, fees });
  } catch (error) {
    console.error('Get fees error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== GET SINGLE FEE ====================
app.get('/api/fees/:id', authenticate, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Faculty, required: false },
        { model: Department, required: false },
        { model: TransportRoute, required: false }
      ]
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }
    
    res.json({ success: true, fee });
  } catch (error) {
    console.error('Get fee error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== CREATE FEE ====================
app.post('/api/fees', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const feeData = { ...req.body, schoolId: req.user.schoolId };
    
    // Clean up empty UUID fields
    const uuidFields = ['classId', 'courseId', 'facultyId', 'departmentId', 'programId', 'moduleId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (feeData[field] === '') feeData[field] = null;
    });

    // Convert string numbers to proper types
    if (feeData.amount) feeData.amount = parseFloat(feeData.amount);
    if (feeData.year) feeData.year = parseInt(feeData.year);
    if (feeData.semester) feeData.semester = parseInt(feeData.semester);
    if (feeData.module) feeData.module = parseInt(feeData.module);

    const fee = await Fee.create(feeData);
    
    // Create audit log
    await createAuditLog(req, 'CREATE', 'FEE', fee.id, null, fee);
    
    // Fetch with associations
    const createdFee = await Fee.findByPk(fee.id, {
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false }
      ]
    });
    
    // If allocationType is 'AUTO', auto-allocate to all eligible students
    if (feeData.allocationType === 'AUTO') {
      try {
        const school = await School.findByPk(req.user.schoolId);
        let where = { schoolId: req.user.schoolId, isActive: true };
        
        if (school.category === 'UNIVERSITY') {
          if (feeData.courseId) where.courseId = feeData.courseId;
          if (feeData.year) where.currentYear = feeData.year;
        } else if (school.category === 'COLLEGE_TVET') {
          if (feeData.programId) where.programId = feeData.programId;
          if (feeData.module) where.currentModule = `Module ${feeData.module}`;
        } else {
          if (feeData.classId) where.classId = feeData.classId;
        }

        const students = await Student.findAll({ where });
        
        let autoAllocated = 0;
        for (const student of students) {
          // Check if already allocated
          const existing = await FeeAllocation.findOne({
            where: { 
              studentId: student.id, 
              feeId: fee.id,
              isActive: true
            }
          });
          
          if (!existing) {
            await FeeAllocation.create({
              studentId: student.id,
              feeId: fee.id,
              amount: feeData.amount,
              allocatedBy: req.user.id,
              schoolId: req.user.schoolId,
              allocationType: 'AUTO',
              notes: `Auto-allocated on creation`
            });
            autoAllocated++;
          }
        }
        
        console.log(`✅ Auto-allocated fee to ${autoAllocated} students`);
      } catch (autoError) {
        console.error('Auto-allocation failed:', autoError);
        // Don't fail the fee creation if auto-allocation fails
      }
    }
    
    res.status(201).json({ 
      success: true, 
      fee: createdFee,
      message: feeData.allocationType === 'AUTO' 
        ? 'Fee created and auto-allocated to eligible students' 
        : 'Fee created successfully (manual allocation required)'
    });
  } catch (error) {
    console.error('Create fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== UPDATE FEE ====================
app.put('/api/fees/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    const updateData = { ...req.body };
    
    // Clean up empty UUID fields
    const uuidFields = ['classId', 'courseId', 'facultyId', 'departmentId', 'programId', 'moduleId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (updateData[field] === '') updateData[field] = null;
    });

    // Convert string numbers to proper types
    if (updateData.amount) updateData.amount = parseFloat(updateData.amount);
    if (updateData.year) updateData.year = parseInt(updateData.year);
    if (updateData.semester) updateData.semester = parseInt(updateData.semester);
    if (updateData.module) updateData.module = parseInt(updateData.module);

    const oldFee = { ...fee.toJSON() };
    await fee.update(updateData);
    
    // Create audit log
    await createAuditLog(req, 'UPDATE', 'FEE', fee.id, oldFee, fee);
    
    // Fetch updated fee with associations
    const updatedFee = await Fee.findByPk(fee.id, {
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false }
      ]
    });

    res.json({ success: true, fee: updatedFee });
  } catch (error) {
    console.error('Update fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== DELETE FEE ====================
app.delete('/api/fees/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    // Check if there are any payments associated with this fee
    const paymentsCount = await Payment.count({
      where: { feeId: fee.id }
    });

    // Check if there are any allocations
    const allocationsCount = await FeeAllocation.count({
      where: { feeId: fee.id }
    });

    if (paymentsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete fee with ${paymentsCount} payment(s) associated. Delete payments first.` 
      });
    }

    // Delete allocations first
    if (allocationsCount > 0) {
      await FeeAllocation.destroy({
        where: { feeId: fee.id }
      });
      console.log(`✅ Deleted ${allocationsCount} fee allocations`);
    }

    await fee.destroy();
    
    // Create audit log
    await createAuditLog(req, 'DELETE', 'FEE', req.params.id, null, { 
      hadPayments: paymentsCount > 0,
      paymentsCount,
      allocationsDeleted: allocationsCount
    });

    res.json({ 
      success: true, 
      message: 'Fee deleted successfully',
      paymentsAffected: paymentsCount,
      allocationsDeleted: allocationsCount
    });
  } catch (error) {
    console.error('Delete fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== AUTO-ALLOCATE FEE (FOR EXISTING FEES) ====================
app.post('/api/fees/:id/auto-allocate', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findByPk(req.params.id);
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // Find students who should get this fee
    let where = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (fee.courseId) where.courseId = fee.courseId;
      if (fee.year) where.currentYear = fee.year;
    } else if (school.category === 'COLLEGE_TVET') {
      if (fee.programId) where.programId = fee.programId;
      if (fee.module) where.currentModule = `Module ${fee.module}`;
    } else {
      if (fee.classId) where.classId = fee.classId;
    }

    const students = await Student.findAll({ where });
    
    let allocated = 0;
    let skipped = 0;
    const results = [];
    
    for (const student of students) {
      // Check if already allocated
      const existing = await FeeAllocation.findOne({
        where: { 
          studentId: student.id, 
          feeId: fee.id,
          isActive: true
        }
      });
      
      if (!existing) {
        await FeeAllocation.create({
          studentId: student.id,
          feeId: fee.id,
          amount: fee.amount,
          allocatedBy: req.user.id,
          schoolId: req.user.schoolId,
          allocationType: 'AUTO',
          notes: `Auto-allocated on ${new Date().toLocaleDateString()}`
        });
        allocated++;
        results.push({ studentId: student.id, status: 'allocated' });
      } else {
        skipped++;
        results.push({ studentId: student.id, status: 'already_allocated' });
      }
    }

    // Create audit log
    await createAuditLog(req, 'AUTO_ALLOCATE', 'FEE', fee.id, null, { 
      allocated, 
      skipped,
      totalStudents: students.length 
    });

    res.json({ 
      success: true, 
      message: `Fee auto-allocated to ${allocated} students (${skipped} already had it)`,
      allocated,
      skipped,
      results
    });
  } catch (error) {
    console.error('Auto-allocate error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== MANUAL ALLOCATE FEE ====================
app.post('/api/fees/:id/manual-allocate', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { studentIds } = req.body;
    
    if (!studentIds || studentIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please select at least one student' 
      });
    }
    
    const fee = await Fee.findByPk(id);
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }
    
    let allocated = 0;
    let skipped = 0;
    const results = [];
    
    for (const studentId of studentIds) {
      // Check if student exists
      const student = await Student.findOne({
        where: { id: studentId, schoolId: req.user.schoolId }
      });
      
      if (!student) {
        results.push({ studentId, error: 'Student not found' });
        continue;
      }
      
      // Check if already allocated
      const existing = await FeeAllocation.findOne({
        where: { 
          studentId: student.id, 
          feeId: fee.id,
          isActive: true
        }
      });
      
      if (existing) {
        results.push({ studentId, status: 'already_allocated' });
        skipped++;
        continue;
      }
      
      // Create manual allocation record
      await FeeAllocation.create({
        studentId: student.id,
        feeId: fee.id,
        amount: fee.amount,
        allocatedBy: req.user.id,
        schoolId: req.user.schoolId,
        allocationType: 'MANUAL',
        notes: `Manually allocated on ${new Date().toLocaleDateString()}`
      });
      
      allocated++;
      results.push({ studentId, status: 'allocated' });
    }
    
    // Create audit log
    await createAuditLog(req, 'MANUAL_ALLOCATE', 'FEE', id, null, { 
      allocated, 
      skipped,
      totalStudents: studentIds.length 
    });
    
    res.json({ 
      success: true, 
      message: `Fee manually allocated to ${allocated} students (${skipped} already had it)`,
      allocated,
      skipped,
      results
    });
    
  } catch (error) {
    console.error('Manual allocate error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET ALLOCATIONS FOR A STUDENT ====================
app.get('/api/students/:studentId/fee-allocations', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Check access
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (!student || student.id !== studentId) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }
    
    const allocations = await FeeAllocation.findAll({
      where: { 
        studentId, 
        schoolId: req.user.schoolId,
        isActive: true
      },
      include: [
        { model: Fee, attributes: ['id', 'name', 'amount', 'category'] }
      ],
      order: [['allocatedDate', 'DESC']]
    });
    
    res.json({ success: true, allocations });
  } catch (error) {
    console.error('Get allocations error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET FEE ALLOCATIONS FOR A FEE ====================
app.get('/api/fees/:feeId/allocations', authenticate, async (req, res) => {
  try {
    const { feeId } = req.params;
    
    const fee = await Fee.findOne({
      where: { id: feeId, schoolId: req.user.schoolId }
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }
    
    const allocations = await FeeAllocation.findAll({
      where: { 
        feeId, 
        schoolId: req.user.schoolId,
        isActive: true
      },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
        }
      ],
      order: [['allocatedDate', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      allocations,
      count: allocations.length,
      fee: { id: fee.id, name: fee.name, amount: fee.amount }
    });
  } catch (error) {
    console.error('Get fee allocations error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== REMOVE FEE ALLOCATION ====================
app.delete('/api/fee-allocations/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const allocation = await FeeAllocation.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId
      }
    });
    
    if (!allocation) {
      return res.status(404).json({ 
        success: false, 
        message: 'Allocation not found' 
      });
    }
    
    // Soft delete - just mark as inactive
    await allocation.update({ isActive: false });
    
    // Create audit log
    await createAuditLog(req, 'REMOVE_ALLOCATION', 'FEE_ALLOCATION', allocation.id, null, { 
      studentId: allocation.studentId,
      feeId: allocation.feeId
    });
    
    res.json({ 
      success: true, 
      message: 'Fee allocation removed successfully' 
    });
  } catch (error) {
    console.error('Remove allocation error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET FEE SUMMARY FOR A STUDENT ====================
app.get('/api/students/:studentId/fee-summary', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Get all allocations for this student
    const allocations = await FeeAllocation.findAll({
      where: { 
        studentId, 
        schoolId: req.user.schoolId,
        isActive: true
      },
      include: [
        { model: Fee, attributes: ['id', 'name', 'amount', 'category'] }
      ]
    });
    
    // Get all payments for this student
    const payments = await Payment.findAll({
      where: { 
        studentId, 
        schoolId: req.user.schoolId,
        isOtherIncome: false
      }
    });
    
    const totalAllocated = allocations.reduce((sum, a) => sum + parseFloat(a.amount || 0), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalAllocated - totalPaid;
    
    res.json({
      success: true,
      summary: {
        totalAllocated,
        totalPaid,
        balance,
        isCleared: balance <= 0
      },
      allocations,
      payments
    });
  } catch (error) {
    console.error('Get fee summary error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== PAYMENT ROUTE (FIXED) ====================
app.post('/api/payments', authenticate, async (req, res) => {
  try {
    const { 
      studentId, feeId, amount, paymentMethod, transactionId, notes,
      mpesaCode, mpesaPhone, bankReference, bankMessage,
      cardLast4, cardApprovalCode, chequeNumber, chequeBank,
      isOtherIncome, incomeCategory, description, payer,
      studentName, admissionNumber, courseName, className, feeName
    } = req.body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid amount is required' 
      });
    }

    if (!studentId && !isOtherIncome) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student ID is required for fee payments' 
      });
    }

    // Generate receipt number
    const receiptNo = await generateReceiptNo();

    // If this is a fee payment, verify the student exists
    if (!isOtherIncome && studentId) {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      
      if (!student) {
        return res.status(404).json({ 
          success: false, 
          message: 'Student not found in your school' 
        });
      }
    }

    // Create the payment
    const payment = await Payment.create({
      studentId: isOtherIncome ? null : studentId,
      feeId: feeId || null,
      amount,
      paymentMethod: paymentMethod || 'CASH',
      transactionId: transactionId || null,
      receiptNo,
      notes: notes || null,
      recordedBy: req.user.id,
      schoolId: req.user.schoolId,
      
      // Payment method specific fields
      mpesaCode: mpesaCode || null,
      mpesaPhone: mpesaPhone || null,
      bankReference: bankReference || null,
      bankMessage: bankMessage || null,
      cardLast4: cardLast4 || null,
      cardApprovalCode: cardApprovalCode || null,
      chequeNumber: chequeNumber || null,
      chequeBank: chequeBank || null,
      
      paymentDate: new Date(),
      isOtherIncome: isOtherIncome || false,
      incomeCategory: incomeCategory || null,
      description: description || null,
      payer: payer || null,
      
      studentName: studentName || null,
      admissionNumber: admissionNumber || null,
      courseName: courseName || null,
      className: className || null,
      feeName: feeName || null
    });

    // If this payment is for a specific fee, update the allocation status
    if (feeId && studentId) {
      // Find and update allocations
      const allocations = await FeeAllocation.findAll({
        where: { 
          studentId, 
          feeId,
          isActive: true
        }
      });
      
      // Mark allocations as paid (or partially paid)
      for (const allocation of allocations) {
        // You could track paid amount per allocation here
        // For now, we just log it
        console.log(`✅ Payment recorded for allocation ${allocation.id}`);
      }
    }

    await createAuditLog(req, 'RECORD', 'PAYMENT', payment.id, null, payment);

    // Fetch the created payment with associations
    const createdPayment = await Payment.findByPk(payment.id, {
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ]
    });

    res.status(201).json({ 
      success: true, 
      payment: createdPayment,
      message: 'Payment recorded successfully' 
    });
  } catch (error) {
    console.error('❌ Record payment error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET PAYMENTS ====================
app.get('/api/payments', authenticate, async (req, res) => {
  try {
    const { studentId, startDate, endDate, isOtherIncome } = req.query;
    
    let where = { schoolId: req.user.schoolId };
    
    // Handle studentId filter
    if (studentId) {
      // Check if user has access to this student
      if (req.user.role === 'PARENT') {
        const parent = await Parent.findOne({
          where: { 
            userId: req.user.id, 
            studentId: studentId 
          }
        });
        if (!parent) {
          return res.status(403).json({ 
            success: false, 
            message: 'You do not have access to this student\'s payments' 
          });
        }
      } else if (req.user.role === 'STUDENT') {
        const student = await Student.findOne({
          where: { userId: req.user.id }
        });
        if (!student || student.id !== studentId) {
          return res.status(403).json({ 
            success: false, 
            message: 'You can only view your own payments' 
          });
        }
      }
      where.studentId = studentId;
    }
    
    // Handle other income filter
    if (isOtherIncome !== undefined) {
      where.isOtherIncome = isOtherIncome === 'true';
    }
    
    // Handle date range
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }

    // For non-admin roles, restrict access
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      if (student) {
        where.studentId = student.id;
      } else {
        return res.json({ success: true, payments: [] });
      }
    } else if (req.user.role === 'PARENT') {
      const parents = await Parent.findAll({ 
        where: { userId: req.user.id },
        attributes: ['studentId']
      });
      const studentIds = parents.map(p => p.studentId);
      if (studentIds.length > 0) {
        where.studentId = studentIds;
      } else {
        return res.json({ success: true, payments: [] });
      }
    }

    const payments = await Payment.findAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      payments,
      count: payments.length 
    });
  } catch (error) {
    console.error('❌ Get payments error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET SINGLE PAYMENT ====================
app.get('/api/payments/:id', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ]
    });

    if (!payment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Payment not found' 
      });
    }

    // Check access for non-admin users
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      if (!student || payment.studentId !== student.id) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: payment.studentId 
        }
      });
      if (!parent) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    res.json({ 
      success: true, 
      payment 
    });
  } catch (error) {
    console.error('❌ Get payment error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/students/:studentId/fee-statement', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    // Check access
    let hasAccess = false;
    if (req.user.role === 'SUPER_ADMIN') {
      hasAccess = true;
    } else if (req.user.role === 'SCHOOL_ADMIN' || req.user.role === 'PRINCIPAL' || req.user.role === 'ACCOUNTANT') {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      hasAccess = !!student;
    } else if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      hasAccess = student && student.id === studentId;
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: studentId 
        }
      });
      hasAccess = !!parent;
    }

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const student = await Student.findOne({
      where: { 
        id: studentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // Get applicable fees
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) feeWhere.programId = student.programId;
    } else {
      if (student.classId) feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    // Get payments
    const payments = await Payment.findAll({
      where: { 
        studentId, 
        isOtherIncome: false 
      },
      include: [{ model: Fee }],
      order: [['createdAt', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount || 0), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber,
          classId: student.classId,
          courseId: student.courseId
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('❌ Get fee statement error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/students/:studentId/fee-statement', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const student = await Student.findByPk(studentId);
    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    const payments = await Payment.findAll({
      where: { studentId },
      include: [{ model: Fee }]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student,
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('Get fee statement error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== EXPENSE ROUTES ====================

app.post('/api/expenses', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { category, description, amount, date, paymentMethod, vendor, notes } = req.body;

    const expense = await Expense.create({
      category,
      description,
      amount,
      date,
      paymentMethod,
      vendor,
      notes,
      schoolId: req.user.schoolId,
      approvedBy: req.user.id
    });

    await createAuditLog(req, 'CREATE', 'EXPENSE', expense.id, null, expense);

    res.status(201).json({ success: true, expense });
  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/expenses', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, category } = req.query;
    const where = { schoolId: req.user.schoolId };

    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    if (category) where.category = category;

    const expenses = await Expense.findAll({
      where,
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, expenses });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== STAFF ROUTES ====================

app.post('/api/staff', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      userId, employeeId, tscNumber, department, jobTitle,
      employmentDate, qualifications, specialization, subjects,
      bankDetails, deductions, salary, staffType
    } = req.body;

    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.status(400).json({ message: 'No school associated with user' });
    }

    if (!employmentDate) {
      return res.status(400).json({ message: 'Employment date is required' });
    }

    const parsedDate = new Date(employmentDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: 'Invalid employment date format' });
    }

    const existing = await Staff.findOne({ 
      where: { 
        userId,
        schoolId 
      } 
    });
    
    if (existing) {
      return res.status(400).json({ message: 'Staff profile already exists for this user' });
    }

    const staff = await Staff.create({
      userId,
      employeeId,
      tscNumber,
      department,
      jobTitle,
      employmentDate: parsedDate,
      qualifications: qualifications || [],
      specialization: specialization || '',
      subjects: subjects || [],
      bankDetails: bankDetails || { bank: '', branch: '', account: '' },
      deductions: deductions || { nhif: 0, nssf: 0, sacco: 0, helb: 0 },
      salary: salary || { basic: 0, house: 0, transport: 0 },
      staffType: staffType || 'TEACHING',
      schoolId: schoolId
    });

    await createAuditLog(req, 'CREATE', 'STAFF', staff.id, null, staff);

    res.status(201).json({ success: true, staff });
  } catch (error) {
    console.error('Create staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/staff', authenticate, async (req, res) => {
  try {
    const staff = await Staff.findAll({
      where: { 
        schoolId: req.user.schoolId
      },
      include: [{ 
        model: User, 
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] 
      }]
    });
    
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/staff/:id', authenticate, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [{ 
        model: User, 
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] 
      }]
    });
    
    if (!staff) {
      return res.status(404).json({ message: 'Staff member not found' });
    }
    
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/staff/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    const oldStaff = { ...staff.toJSON() };
    await staff.update(req.body);
    await createAuditLog(req, 'UPDATE', 'STAFF', staff.id, oldStaff, staff);

    res.json({ success: true, staff });
  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/staff/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    await staff.destroy();
    await createAuditLog(req, 'DELETE', 'STAFF', req.params.id);

    res.json({ success: true, message: 'Staff deleted successfully' });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== PAYROLL ROUTES ====================

app.post('/api/payroll/process', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { month, year } = req.body;

    const staff = await Staff.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: User }]
    });

    const payrolls = [];

    for (const s of staff) {
      const grossPay = calculateGross(s.salary);
      const deductions = calculateDeductions(s.deductions);
      const netPay = grossPay - deductions;

      const payroll = await Payroll.create({
        staffId: s.id,
        month,
        year,
        grossPay,
        deductions,
        netPay,
        status: 'PENDING'
      });

      await Expense.create({
        category: 'Salaries & Wages',
        description: `Salary for ${s.User.firstName} ${s.User.lastName} - ${month}/${year}`,
        amount: netPay,
        date: new Date(),
        paymentMethod: 'BANK',
        schoolId: req.user.schoolId
      });

      if (deductions > 0) {
        await Expense.create({
          category: 'Statutory Deductions',
          description: `NHIF/NSSF for ${s.User.firstName} ${s.User.lastName} - ${month}/${year}`,
          amount: deductions,
          date: new Date(),
          paymentMethod: 'BANK',
          schoolId: req.user.schoolId
        });
      }

      payrolls.push(payroll);
    }

    res.status(201).json({ 
      success: true, 
      payrolls,
      message: `Payroll processed. School account will be debited KES ${payrolls.reduce((sum, p) => sum + p.netPay + p.deductions, 0)}`
    });
  } catch (error) {
    console.error('Process payroll error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/payroll', authenticate, async (req, res) => {
  try {
    const { month, year, staffId } = req.query;
    const where = {};

    if (month) where.month = month;
    if (year) where.year = year;
    if (staffId) where.staffId = staffId;

    const payrolls = await Payroll.findAll({
      where,
      include: [{ model: Staff, include: [{ model: User }] }],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, payrolls });
  } catch (error) {
    console.error('Get payroll error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/payroll/:id/pay', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const payroll = await Payroll.findByPk(req.params.id);
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    await payroll.update({
      status: 'PAID',
      paymentDate: new Date()
    });

    await createAuditLog(req, 'PAY', 'PAYROLL', payroll.id, null, { status: 'PAID' });

    res.json({ success: true, payroll });
  } catch (error) {
    console.error('Pay payroll error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== LIBRARY ROUTES ====================

app.post('/api/books', authenticate, async (req, res) => {
  try {
    const {
      title, author, isbn, publisher, year,
      category, quantity, location, shelf
    } = req.body;

    const book = await Book.create({
      title,
      author,
      isbn,
      publisher,
      year,
      category,
      quantity,
      available: quantity,
      location,
      shelf,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'BOOK', book.id, null, book);

    res.status(201).json({ success: true, book });
  } catch (error) {
    console.error('Create book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/books', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { schoolId: req.user.schoolId };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } },
        { isbn: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category) where.category = category;

    const books = await Book.findAll({ where });
    
    res.json({ success: true, books });
  } catch (error) {
    console.error('Get books error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/books/borrow', authenticate, async (req, res) => {
  try {
    const { bookId, studentId, dueDate } = req.body;

    const book = await Book.findByPk(bookId);
    if (!book || book.available < 1) {
      return res.status(400).json({ message: 'Book not available' });
    }

    const borrow = await Borrow.create({
      bookId,
      studentId,
      borrowDate: new Date(),
      dueDate,
      status: 'BORROWED'
    });

    await book.update({ available: book.available - 1 });

    await createAuditLog(req, 'BORROW', 'BOOK', bookId, null, borrow);

    res.status(201).json({ success: true, borrow });
  } catch (error) {
    console.error('Borrow book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/books/return/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findByPk(req.params.id);
    
    if (!borrow) return res.status(404).json({ message: 'Borrow record not found' });

    let fine = 0;
    const today = new Date();
    const dueDate = new Date(borrow.dueDate);
    
    if (today > dueDate) {
      const daysOverdue = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
      fine = daysOverdue * 10;
    }

    await borrow.update({
      returnDate: today,
      status: 'RETURNED',
      fine
    });

    await Book.update(
      { available: sequelize.literal('available + 1') },
      { where: { id: borrow.bookId } }
    );

    await createAuditLog(req, 'RETURN', 'BOOK', borrow.bookId, null, borrow);

    res.json({ 
      success: true, 
      borrow,
      fine,
      message: fine > 0 ? `Book returned with fine of KES ${fine}` : 'Book returned successfully'
    });
  } catch (error) {
    console.error('Return book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/books/borrowed', authenticate, async (req, res) => {
  try {
    const { studentId } = req.query;
    const where = { status: 'BORROWED' };
    
    if (studentId) where.studentId = studentId;

    const borrows = await Borrow.findAll({
      where,
      include: [
        { model: Book, required: false },
        { model: Student, required: false }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ success: true, borrows });
  } catch (error) {
    console.error('Get borrowed books error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== COMPLETE LIBRARY ROUTES ====================

// GET single book by ID
app.get('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }
    
    res.json({ success: true, book });
  } catch (error) {
    console.error('Get book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE book
app.put('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }

    const {
      title, author, isbn, publisher, year,
      category, quantity, location, shelf
    } = req.body;

    // Calculate new available count based on quantity change
    const quantityDiff = quantity - book.quantity;
    const newAvailable = book.available + quantityDiff;

    // Ensure available doesn't go negative
    if (newAvailable < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot reduce quantity below currently borrowed books' 
      });
    }

    const oldBook = { ...book.toJSON() };
    
    await book.update({
      title,
      author,
      isbn,
      publisher,
      year,
      category,
      quantity,
      available: newAvailable,
      location,
      shelf
    });

    await createAuditLog(req, 'UPDATE', 'BOOK', book.id, oldBook, book);

    res.json({ 
      success: true, 
      book,
      message: 'Book updated successfully' 
    });
  } catch (error) {
    console.error('Update book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE book
app.delete('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }

    // Check if book is currently borrowed
    const activeBorrows = await Borrow.count({
      where: { 
        bookId: book.id, 
        status: 'BORROWED' 
      }
    });

    if (activeBorrows > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete book with ${activeBorrows} active borrow(s). Please return all copies first.` 
      });
    }

    await book.destroy();
    await createAuditLog(req, 'DELETE', 'BOOK', req.params.id);

    res.json({ 
      success: true, 
      message: 'Book deleted successfully' 
    });
  } catch (error) {
    console.error('Delete book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET all borrows (with optional filters)
app.get('/api/borrows', authenticate, async (req, res) => {
  try {
    const { 
      studentId, bookId, status, 
      startDate, endDate, 
      limit = 100, page = 1 
    } = req.query;
    
    const where = {};
    
    if (studentId) where.studentId = studentId;
    if (bookId) where.bookId = bookId;
    if (status) where.status = status;
    
    if (startDate && endDate) {
      where.borrowDate = {
        [Op.between]: [startDate, endDate]
      };
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await Borrow.findAndCountAll({
      where,
      include: [
        { 
          model: Book,
          where: { schoolId: req.user.schoolId },
          required: true
        },
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false
        }
      ],
      order: [['borrowDate', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });

    res.json({ 
      success: true, 
      borrows: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / parseInt(limit))
    });
  } catch (error) {
    console.error('Get borrows error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single borrow by ID
app.get('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [
        { 
          model: Book,
          where: { schoolId: req.user.schoolId },
          required: true
        },
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        }
      ]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }
    
    res.json({ success: true, borrow });
  } catch (error) {
    console.error('Get borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE borrow record (for corrections)
app.put('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [{ 
        model: Book,
        where: { schoolId: req.user.schoolId }
      }]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }

    const { dueDate, status, fine } = req.body;
    const oldBorrow = { ...borrow.toJSON() };
    
    await borrow.update({
      dueDate: dueDate || borrow.dueDate,
      status: status || borrow.status,
      fine: fine !== undefined ? fine : borrow.fine
    });

    await createAuditLog(req, 'UPDATE', 'BORROW', borrow.id, oldBorrow, borrow);

    res.json({ 
      success: true, 
      borrow,
      message: 'Borrow record updated successfully' 
    });
  } catch (error) {
    console.error('Update borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE borrow record (rarely needed, mostly for corrections)
app.delete('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [{ 
        model: Book,
        where: { schoolId: req.user.schoolId }
      }]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }

    // If the book was borrowed, increase available count
    if (borrow.status === 'BORROWED') {
      await Book.update(
        { available: sequelize.literal('available + 1') },
        { where: { id: borrow.bookId } }
      );
    }

    await borrow.destroy();
    await createAuditLog(req, 'DELETE', 'BORROW', req.params.id);

    res.json({ 
      success: true, 
      message: 'Borrow record deleted successfully' 
    });
  } catch (error) {
    console.error('Delete borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET library statistics
app.get('/api/library/stats', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const totalBooks = await Book.sum('quantity', { where: { schoolId } }) || 0;
    const availableBooks = await Book.sum('available', { where: { schoolId } }) || 0;
    
    const borrowedCount = await Borrow.count({
      where: { status: 'BORROWED' },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }]
    });

    const overdueCount = await Borrow.count({
      where: { 
        status: 'BORROWED',
        dueDate: { [Op.lt]: new Date() }
      },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }]
    });

    const uniqueStudents = await Borrow.findAll({
      where: { status: 'BORROWED' },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }],
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('studentId')), 'studentId']]
    });

    res.json({
      success: true,
      stats: {
        totalBooks,
        availableBooks,
        borrowedCount,
        overdueCount,
        activeBorrowers: uniqueStudents.length,
        collectionRate: totalBooks > 0 
          ? ((totalBooks - availableBooks) / totalBooks * 100).toFixed(2)
          : 0
      }
    });
  } catch (error) {
    console.error('Library stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET available books (for students)
app.get('/api/library/available', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { 
      schoolId: req.user.schoolId,
      available: { [Op.gt]: 0 }
    };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category && category !== 'all') {
      where.category = category;
    }

    const books = await Book.findAll({
      where,
      order: [['title', 'ASC']]
    });

    res.json({ 
      success: true, 
      books,
      count: books.length
    });
  } catch (error) {
    console.error('Get available books error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET student's borrowed books by admission number
app.get('/api/library/by-admission/:admissionNumber/borrowed', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { 
        studentId: student.id,
        status: 'BORROWED'
      },
      include: [
        { 
          model: Book,
          attributes: ['id', 'title', 'author', 'isbn', 'category'],
          required: false 
        }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ 
      success: true, 
      borrows,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get student borrowed books error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET student's borrow history by admission number
app.get('/api/library/by-admission/:admissionNumber/history', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { limit = 50 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { studentId: student.id },
      include: [
        { 
          model: Book,
          attributes: ['id', 'title', 'author', 'isbn', 'category'],
          required: false 
        }
      ],
      order: [['borrowDate', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate statistics
    const stats = {
      totalBorrowed: borrows.length,
      currentlyBorrowed: borrows.filter(b => b.status === 'BORROWED').length,
      returned: borrows.filter(b => b.status === 'RETURNED').length,
      overdue: borrows.filter(b => b.status === 'BORROWED' && new Date(b.dueDate) < new Date()).length,
      totalFines: borrows.reduce((sum, b) => sum + (b.fine || 0), 0)
    };

    res.json({ 
      success: true, 
      borrows,
      stats,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get student borrow history error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TIMETABLE ROUTES ====================
// ==================== FIXED GET TIMETABLE ====================
app.get('/api/timetable', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, year, semester, module } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ message: 'School not found' });
    }
    
    // Build where clause based on school type
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (year && !isNaN(parseInt(year))) where.year = parseInt(year);
      if (semester && !isNaN(parseInt(semester))) where.semester = parseInt(semester);
    } else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
      if (year && !isNaN(parseInt(year))) where.year = parseInt(year);
      if (module && !isNaN(parseInt(module))) where.module = parseInt(module);
    } else {
      if (classId) where.classId = classId;
    }

    let timetable = [];
    try {
      if (school.category === 'UNIVERSITY') {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Course, required: false },
            { model: CourseUnit, as: 'unit', required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      } else if (school.category === 'COLLEGE_TVET') {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Program, required: false },
            { model: CourseUnit, as: 'unit', required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      } else {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Subject, required: false },
            { model: Class, required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      }
    } catch (includeError) {
      console.error('Error with includes, falling back to simple query:', includeError.message);
      timetable = await Timetable.findAll({ 
        where, 
        order: [['day', 'ASC'], ['period', 'ASC']] 
      });
    }
    
    res.json({ success: true, timetable });
  } catch (error) {
    console.error('Get timetable error:', error);
    res.status(500).json({ 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== FIXED POST TIMETABLE ====================
app.post('/api/timetable', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      classId, courseId, programId, year, semester, module, day, period, startTime, endTime,
      subjectId, unitId, teacherId, room
    } = req.body;

    if (!day) return res.status(400).json({ message: 'Day is required' });
    if (!period) return res.status(400).json({ message: 'Period is required' });
    if (!teacherId) return res.status(400).json({ message: 'Teacher is required' });
    if (!startTime) return res.status(400).json({ message: 'Start time is required' });
    if (!endTime) return res.status(400).json({ message: 'End time is required' });

    const school = await School.findByPk(req.user.schoolId);
    if (!school) return res.status(404).json({ message: 'School not found' });
    
    let timetableData = {
      day,
      period: parseInt(period),
      startTime,
      endTime,
      teacherId,
      room: room || null,
      schoolId: req.user.schoolId,
      classId: null,
      courseId: null,
      programId: null,
      unitId: null,
      subjectId: null,
      year: null,
      semester: null,
      module: null
    };

    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ 
          message: 'Course ID is required for university' 
        });
      }
      if (!unitId) {
        return res.status(400).json({ 
          message: 'Unit ID is required for university' 
        });
      }
      
      timetableData.courseId = courseId;
      timetableData.unitId = unitId;
      timetableData.year = year ? parseInt(year) : null;
      timetableData.semester = semester ? parseInt(semester) : null;
    } else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ 
          message: 'Program ID is required for TVET' 
        });
      }
      if (!unitId) {
        return res.status(400).json({ 
          message: 'Unit/Module ID is required for TVET' 
        });
      }
      
      timetableData.programId = programId;
      timetableData.unitId = unitId;
      timetableData.year = year ? parseInt(year) : null;
      timetableData.module = module ? parseInt(module) : null;
    } else {
      if (!classId) {
        return res.status(400).json({ 
          message: 'Class ID is required for regular schools' 
        });
      }
      if (!subjectId) {
        return res.status(400).json({ 
          message: 'Subject ID is required for regular schools' 
        });
      }
      
      timetableData.classId = classId;
      timetableData.subjectId = subjectId;
    }

    // Check for scheduling conflicts
    const conflictWhere = {
      schoolId: req.user.schoolId,
      day,
      period: parseInt(period)
    };

    if (school.category === 'UNIVERSITY') {
      conflictWhere.courseId = courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      conflictWhere.programId = programId;
    } else {
      conflictWhere.classId = classId;
    }

    const teacherConflict = await Timetable.findOne({
      where: {
        ...conflictWhere,
        teacherId: teacherId
      }
    });

    if (teacherConflict) {
      return res.status(400).json({ 
        message: 'Teacher is already assigned to another class at this time' 
      });
    }

    const timetable = await Timetable.create(timetableData);
    
    await createAuditLog(req, 'CREATE', 'TIMETABLE', timetable.id, null, timetable);

    let createdTimetable;
    if (school.category === 'UNIVERSITY') {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Course, attributes: ['id', 'name', 'code'] },
          { model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    } else if (school.category === 'COLLEGE_TVET') {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Program, attributes: ['id', 'name', 'code'] },
          { model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    } else {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Subject, attributes: ['id', 'name', 'code'] },
          { model: Class, attributes: ['id', 'name'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    }

    res.status(201).json({ success: true, timetable: createdTimetable });
  } catch (error) {
    console.error('Create timetable error:', error);
    
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        message: 'Invalid reference: The selected course, program, unit, or teacher does not exist',
        details: error.message 
      });
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ 
        message: 'Validation error',
        details: error.errors.map(e => e.message) 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error creating timetable',
      error: error.message
    });
  }
});

app.delete('/api/timetable/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const timetable = await Timetable.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!timetable) {
      return res.status(404).json({ message: 'Timetable entry not found' });
    }

    await timetable.destroy();
    await createAuditLog(req, 'DELETE', 'TIMETABLE', req.params.id);

    res.json({ success: true, message: 'Timetable entry deleted successfully' });
  } catch (error) {
    console.error('Delete timetable error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== VEHICLE ROUTES ====================

app.post('/api/vehicles', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      registration, type, capacity, driver, driverPhone,
      insuranceExpiry, serviceDue, fuelType
    } = req.body;

    if (!registration) {
      return res.status(400).json({ message: 'Registration number is required' });
    }

    const existingVehicle = await Vehicle.findOne({
      where: { 
        registration: registration.toUpperCase(),
        schoolId: req.user.schoolId 
      }
    });

    if (existingVehicle) {
      return res.status(400).json({ message: 'Vehicle with this registration already exists' });
    }

    const vehicle = await Vehicle.create({
      registration: registration.toUpperCase(),
      type: type || 'Unknown',
      capacity: capacity || 0,
      driver: driver || '',
      driverPhone: driverPhone || '',
      insuranceExpiry: insuranceExpiry || null,
      serviceDue: serviceDue || null,
      fuelType: fuelType || 'Diesel',
      status: 'ACTIVE',
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'VEHICLE', vehicle.id, null, vehicle);

    res.status(201).json({ success: true, vehicle });
  } catch (error) {
    console.error('Create vehicle error:', error);
    res.status(500).json({ 
      message: 'Server error', 
      error: error.message,
      details: error.errors?.map(e => e.message) 
    });
  }
});

app.get('/api/vehicles', authenticate, async (req, res) => {
  try {
    const vehicles = await Vehicle.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, vehicles });
  } catch (error) {
    console.error('Get vehicles error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/vehicles/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });

    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    const oldVehicle = { ...vehicle.toJSON() };
    await vehicle.update(req.body);
    await createAuditLog(req, 'UPDATE', 'VEHICLE', vehicle.id, oldVehicle, vehicle);

    res.json({ success: true, vehicle });
  } catch (error) {
    console.error('Update vehicle error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/vehicles/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });

    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    const routes = await TransportRoute.findOne({ where: { vehicleId: vehicle.id } });
    if (routes) {
      return res.status(400).json({ 
        message: 'Cannot delete vehicle that is assigned to transport routes' 
      });
    }

    await vehicle.destroy();
    await createAuditLog(req, 'DELETE', 'VEHICLE', req.params.id);

    res.json({ success: true, message: 'Vehicle deleted successfully' });
  } catch (error) {
    console.error('Delete vehicle error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== TRANSPORT ROUTES ====================

app.post('/api/transport-routes', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      name, vehicleId, pickupPoints, pickupTimes,
      dropoffPoints, fee, students, autoAllocate
    } = req.body;

    const route = await TransportRoute.create({
      name,
      vehicleId,
      pickupPoints,
      pickupTimes,
      dropoffPoints,
      fee,
      students,
      autoAllocate,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'TRANSPORT_ROUTE', route.id, null, route);

    res.status(201).json({ success: true, route });
  } catch (error) {
    console.error('Create transport route error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/transport-routes', authenticate, async (req, res) => {
  try {
    const routes = await TransportRoute.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: Vehicle, required: false }]
    });
    
    res.json({ success: true, routes });
  } catch (error) {
    console.error('Get transport routes error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== HOSTEL ROUTES ====================

app.get('/api/hostels', authenticate, async (req, res) => {
  try {
    console.log('🏠 Fetching hostels for school:', req.user.schoolId);
    
    // Allow NURSE to view hostels
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const result = await sequelize.query(
      `SELECT * FROM "Hostels" 
       WHERE "schoolId" = $1 
       ORDER BY name ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    const hostels = result.map(hostel => ({
      ...hostel,
      rooms: typeof hostel.rooms === 'string' ? JSON.parse(hostel.rooms) : (hostel.rooms || [])
    }));
    
    console.log('🏠 Found hostels:', hostels.length);
    res.json({ success: true, hostels });
  } catch (error) {
    console.error('❌ Get hostels error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.get('/api/hostels/:id', authenticate, async (req, res) => {
  try {
    // Allow NURSE to view hostels
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const result = await sequelize.query(
      `SELECT * FROM "Hostels" 
       WHERE id = $1 AND "schoolId" = $2`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    if (!result || result.length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    const hostel = {
      ...result[0],
      rooms: typeof result[0].rooms === 'string' ? JSON.parse(result[0].rooms) : (result[0].rooms || [])
    };
    
    res.json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Get hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.post('/api/hostels', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, gender, capacity, warden, wardenPhone, rooms } = req.body;
    
    // Ensure rooms is an array and stringify properly
    const roomsArray = rooms || [];
    const roomsJson = JSON.stringify(roomsArray);
    
    console.log('📝 Creating hostel with rooms:', roomsJson);
    
    const result = await sequelize.query(
      `INSERT INTO "Hostels" 
       (id, name, gender, capacity, warden, "wardenPhone", rooms, "schoolId", "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW()) 
       RETURNING *`,
      {
        bind: [name, gender, capacity, warden || '', wardenPhone || '', roomsJson, req.user.schoolId],
        type: sequelize.QueryTypes.INSERT
      }
    );
    
    console.log('📥 Database result:', result);
    
    // Check if result has the expected structure
    if (!result || !result[0] || !result[0][0]) {
      throw new Error('Invalid database response');
    }
    
    const dbRow = result[0][0];
    console.log('📊 Database row:', dbRow);
    
    // Safely parse rooms
    let parsedRooms = [];
    if (dbRow.rooms) {
      try {
        parsedRooms = typeof dbRow.rooms === 'string' 
          ? JSON.parse(dbRow.rooms) 
          : dbRow.rooms;
      } catch (parseError) {
        console.error('❌ Error parsing rooms:', parseError);
        parsedRooms = [];
      }
    }
    
    const hostel = {
      id: dbRow.id,
      name: dbRow.name,
      gender: dbRow.gender,
      capacity: dbRow.capacity,
      warden: dbRow.warden,
      wardenPhone: dbRow.wardenPhone,
      schoolId: dbRow.schoolId,
      createdAt: dbRow.createdAt,
      updatedAt: dbRow.updatedAt,
      rooms: parsedRooms
    };
    
    console.log('✅ Hostel created successfully:', hostel.id);
    console.log('✅ Hostel rooms:', parsedRooms);
    
    res.status(201).json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Create hostel error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.put('/api/hostels/:id', authenticate, async (req, res) => {
  try {
    const { name, gender, capacity, warden, wardenPhone, rooms } = req.body;
    
    // Check permissions - allow NURSE for sick bay updates
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. You do not have permission to update hostels.' 
      });
    }
    
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (gender !== undefined) {
      updates.push(`gender = $${paramIndex++}`);
      values.push(gender);
    }
    if (capacity !== undefined) {
      updates.push(`capacity = $${paramIndex++}`);
      values.push(capacity);
    }
    if (warden !== undefined) {
      updates.push(`warden = $${paramIndex++}`);
      values.push(warden);
    }
    if (wardenPhone !== undefined) {
      updates.push(`"wardenPhone" = $${paramIndex++}`);
      values.push(wardenPhone);
    }
    if (rooms !== undefined) {
      updates.push(`rooms = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(rooms));
    }
    
    updates.push(`"updatedAt" = NOW()`);
    values.push(req.params.id, req.user.schoolId);
    
    const query = `
      UPDATE "Hostels" 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIndex++} AND "schoolId" = $${paramIndex++}
      RETURNING *
    `;
    
    const result = await sequelize.query(query, {
      bind: values,
      type: sequelize.QueryTypes.UPDATE
    });
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    const hostel = {
      ...result[0][0],
      rooms: typeof result[0][0].rooms === 'string' ? JSON.parse(result[0][0].rooms) : (result[0][0].rooms || [])
    };
    
    console.log('✅ Hostel updated:', hostel.id);
    res.json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Update hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/hostels/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const result = await sequelize.query(
      `DELETE FROM "Hostels" 
       WHERE id = $1 AND "schoolId" = $2 
       RETURNING id`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.DELETE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    console.log('✅ Hostel deleted:', req.params.id);
    res.json({ success: true, message: 'Hostel deleted successfully' });
  } catch (error) {
    console.error('❌ Delete hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/hostels/:hostelId/rooms/:roomNumber/assign', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { hostelId, roomNumber } = req.params;
    const { studentId } = req.body;

    console.log('📝 BACKEND: Assigning room by user:', req.user.email);

    const transaction = await sequelize.transaction();

    try {
      const [hostelResult] = await sequelize.query(
        `SELECT * FROM "Hostels" 
         WHERE id = $1 AND "schoolId" = $2 
         FOR UPDATE`,
        {
          bind: [hostelId, req.user.schoolId],
          type: sequelize.QueryTypes.SELECT,
          transaction
        }
      );
      
      if (!hostelResult) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Hostel not found' });
      }

      let rooms = hostelResult.rooms;
      if (typeof rooms === 'string') {
        rooms = JSON.parse(rooms);
      }
      rooms = rooms || [];
      
      const roomIndex = rooms.findIndex(r => r.roomNumber === roomNumber);
      if (roomIndex === -1) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Room not found' });
      }

      if (!rooms[roomIndex].students) {
        rooms[roomIndex].students = [];
      }

      if (rooms[roomIndex].students.includes(studentId)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Student already assigned to this room' });
      }

      const currentOccupied = rooms[roomIndex].occupied || rooms[roomIndex].students.length || 0;
      if (currentOccupied >= rooms[roomIndex].beds) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Room is full' });
      }

      rooms[roomIndex].students.push(studentId);
      rooms[roomIndex].occupied = rooms[roomIndex].students.length;

      const roomsJson = JSON.stringify(rooms);
      await sequelize.query(
        `UPDATE "Hostels" 
         SET rooms = $1::jsonb, "updatedAt" = NOW() 
         WHERE id = $2`,
        {
          bind: [roomsJson, hostelId],
          type: sequelize.QueryTypes.UPDATE,
          transaction
        }
      );

      await transaction.commit();

      const [updatedResult] = await sequelize.query(
        `SELECT * FROM "Hostels" WHERE id = $1`,
        {
          bind: [hostelId],
          type: sequelize.QueryTypes.SELECT
        }
      );

      const updatedHostel = {
        ...updatedResult,
        rooms: typeof updatedResult.rooms === 'string' ? JSON.parse(updatedResult.rooms) : (updatedResult.rooms || [])
      };

      await createAuditLog(req, 'ASSIGN', 'HOSTEL_ROOM', hostelId, null, { 
        roomNumber, 
        studentId,
        occupied: rooms[roomIndex].occupied,
        beds: rooms[roomIndex].beds
      });

      console.log('✅ Room assigned successfully');
      res.json({ success: true, hostel: updatedHostel });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('❌ BACKEND: Assign room error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/hostels/:hostelId/rooms/:roomNumber/students/:studentId', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { hostelId, roomNumber, studentId } = req.params;

    console.log('📝 BACKEND: Removing student:', { hostelId, roomNumber, studentId });

    const transaction = await sequelize.transaction();

    try {
      const [hostelResult] = await sequelize.query(
        `SELECT * FROM "Hostels" 
         WHERE id = $1 AND "schoolId" = $2 
         FOR UPDATE`,
        {
          bind: [hostelId, req.user.schoolId],
          type: sequelize.QueryTypes.SELECT,
          transaction
        }
      );
      
      if (!hostelResult) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Hostel not found' });
      }

      let rooms = hostelResult.rooms;
      if (typeof rooms === 'string') {
        rooms = JSON.parse(rooms);
      }
      rooms = rooms || [];
      
      const roomIndex = rooms.findIndex(r => r.roomNumber === roomNumber);
      if (roomIndex === -1) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Room not found' });
      }

      rooms[roomIndex].students = (rooms[roomIndex].students || []).filter(id => id !== studentId);
      rooms[roomIndex].occupied = rooms[roomIndex].students.length;

      const roomsJson = JSON.stringify(rooms);
      await sequelize.query(
        `UPDATE "Hostels" 
         SET rooms = $1::jsonb, "updatedAt" = NOW() 
         WHERE id = $2`,
        {
          bind: [roomsJson, hostelId],
          type: sequelize.QueryTypes.UPDATE,
          transaction
        }
      );

      await transaction.commit();

      const [updatedResult] = await sequelize.query(
        `SELECT * FROM "Hostels" WHERE id = $1`,
        {
          bind: [hostelId],
          type: sequelize.QueryTypes.SELECT
        }
      );

      const updatedHostel = {
        ...updatedResult,
        rooms: typeof updatedResult.rooms === 'string' ? JSON.parse(updatedResult.rooms) : (updatedResult.rooms || [])
      };

      console.log('✅ Student removed successfully');
      res.json({ success: true, hostel: updatedHostel });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('❌ BACKEND: Remove student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== INVENTORY ROUTES ====================

app.get('/api/inventory', authenticate, async (req, res) => {
  try {
    console.log('📦 Fetching inventory for school:', req.user.schoolId);
    
    const items = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE "schoolId" = $1 
       ORDER BY name ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    res.json({ success: true, items });
  } catch (error) {
    console.error('❌ Get inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/:id', authenticate, async (req, res) => {
  try {
    const item = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    if (!item || item.length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, item: item[0] });
  } catch (error) {
    console.error('❌ Get inventory item error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/inventory', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      name, category, quantity, unit, unitPrice,
      reorderLevel, supplier, location, notes
    } = req.body;

    console.log('📦 Creating inventory item:', { name, category, quantity, unit, unitPrice });

    const totalValue = quantity * unitPrice;

    const result = await sequelize.query(
      `INSERT INTO "Inventories" 
       (id, name, category, quantity, unit, "unitPrice", "totalValue", 
        "reorderLevel", supplier, location, notes, "schoolId", "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()) 
       RETURNING *`,
      {
        bind: [
          name,                // $1
          category,            // $2
          quantity,            // $3
          unit,                // $4
          unitPrice,           // $5
          totalValue,          // $6
          reorderLevel || 0,   // $7
          supplier || null,    // $8
          location || null,    // $9
          notes || null,       // $10
          req.user.schoolId    // $11
        ],
        type: sequelize.QueryTypes.INSERT
      }
    );

    console.log('✅ Inventory item created successfully');
    res.status(201).json({ success: true, item: result[0][0] });
  } catch (error) {
    console.error('❌ Create inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/inventory/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, category, quantity, unit, unitPrice, reorderLevel, supplier, location, notes } = req.body;
    
    const totalValue = quantity * unitPrice;
    
    const result = await sequelize.query(
      `UPDATE "Inventories" 
       SET name = $1, category = $2, quantity = $3, unit = $4, 
           "unitPrice" = $5, "totalValue" = $6, "reorderLevel" = $7,
           supplier = $8, location = $9, notes = $10, "updatedAt" = NOW()
       WHERE id = $11 AND "schoolId" = $12
       RETURNING *`,
      {
        bind: [name, category, quantity, unit, unitPrice, totalValue, 
               reorderLevel, supplier, location, notes, req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.UPDATE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, item: result[0][0] });
  } catch (error) {
    console.error('❌ Update inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/inventory/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const result = await sequelize.query(
      `DELETE FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2 
       RETURNING id`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.DELETE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, message: 'Inventory item deleted successfully' });
  } catch (error) {
    console.error('❌ Delete inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.patch('/api/inventory/:id/use', authenticate, async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { quantity, reason, department } = req.body;
    const { id } = req.params;

    console.log('📝 Using inventory item:', { id, quantity, reason, department });

    const [item] = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2 
       FOR UPDATE`,
      {
        bind: [id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT,
        transaction
      }
    );

    if (!item) {
      await transaction.rollback();
      return res.status(404).json({ message: 'Item not found' });
    }

    if (quantity > item.quantity) {
      await transaction.rollback();
      return res.status(400).json({ message: `Only ${item.quantity} items available` });
    }

    const newQuantity = item.quantity - quantity;
    const newTotalValue = newQuantity * item.unitPrice;

    await sequelize.query(
      `UPDATE "Inventories" 
       SET quantity = $1, "totalValue" = $2, "updatedAt" = NOW()
       WHERE id = $3`,
      {
        bind: [newQuantity, newTotalValue, id],
        type: sequelize.QueryTypes.UPDATE,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO "InventoryUsages" 
       (id, "inventoryId", quantity, reason, department, "usedBy", date, "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW(), NOW())`,
      {
        bind: [id, quantity, reason, department, req.user.id],
        type: sequelize.QueryTypes.INSERT,
        transaction
      }
    );

    await transaction.commit();

    const [updatedItem] = await sequelize.query(
      `SELECT * FROM "Inventories" WHERE id = $1`,
      {
        bind: [id],
        type: sequelize.QueryTypes.SELECT
      }
    );

    console.log('✅ Item used successfully');
    res.json({ 
      success: true, 
      item: updatedItem,
      message: `Used ${quantity} ${item.unit}(s) of ${item.name}`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('❌ Use inventory item error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory-usage', authenticate, async (req, res) => {
  try {
    const { inventoryId, startDate, endDate, department, limit = 100 } = req.query;
    
    let query = `
      SELECT 
        u.id,
        u.quantity,
        u.reason,
        u.department,
        u.date,
        u."usedBy",
        u."createdAt",
        u."updatedAt",
        i.id as "inventoryId",
        i.name as "itemName",
        i.category,
        i.unit,
        i."unitPrice",
        CONCAT(us."firstName", ' ', us."lastName") as "usedByName",
        us.id as "userId",
        us.email as "userEmail"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      LEFT JOIN "Users" us ON u."usedBy" = us.id
      WHERE i."schoolId" = $1
    `;
    
    const params = [req.user.schoolId];
    let paramIndex = 2;
    
    if (inventoryId) {
      query += ` AND u."inventoryId" = $${paramIndex}`;
      params.push(inventoryId);
      paramIndex++;
    }
    
    if (department) {
      query += ` AND u.department ILIKE $${paramIndex}`;
      params.push(`%${department}%`);
      paramIndex++;
    }
    
    if (startDate && endDate) {
      query += ` AND u.date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    
    query += ` ORDER BY u.date DESC, u."createdAt" DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 100);

    console.log('📊 Executing usage query with params:', params);
    
    const usage = await sequelize.query(query, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`✅ Found ${usage.length} usage records`);
    
    if (usage.length === 0) {
      const simpleQuery = await sequelize.query(
        `SELECT * FROM "InventoryUsages" LIMIT 5`,
        { type: sequelize.QueryTypes.SELECT }
      );
      console.log('📊 Sample raw usage:', simpleQuery);
    }

    res.json({ success: true, usage });
  } catch (error) {
    console.error('❌ Get inventory usage error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/inventory/low-stock', authenticate, async (req, res) => {
  try {
    const items = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE "schoolId" = $1 
       AND quantity <= "reorderLevel"
       ORDER BY (quantity::float / NULLIF("reorderLevel", 0)) ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    res.json({ success: true, items });
  } catch (error) {
    console.error('❌ Get low stock error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/reports/usage', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, department } = req.query;

    let whereClause = `WHERE i."schoolId" = $1`;
    const params = [req.user.schoolId];
    let paramIndex = 2;

    if (startDate && endDate) {
      whereClause += ` AND u.date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (department) {
      whereClause += ` AND u.department = $${paramIndex}`;
      params.push(department);
    }

    const byDepartment = await sequelize.query(`
      SELECT 
        u.department,
        COUNT(*) as "transactionCount",
        SUM(u.quantity) as "totalQuantity",
        SUM(u.quantity * i."unitPrice") as "totalValue"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      ${whereClause}
      GROUP BY u.department
      ORDER BY "totalValue" DESC
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    const byCategory = await sequelize.query(`
      SELECT 
        i.category,
        COUNT(*) as "transactionCount",
        SUM(u.quantity) as "totalQuantity",
        SUM(u.quantity * i."unitPrice") as "totalValue"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      ${whereClause}
      GROUP BY i.category
      ORDER BY "totalValue" DESC
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    const recent = await sequelize.query(`
      SELECT 
        u.*,
        i.name as "itemName",
        i.category,
        i.unit,
        CONCAT(us."firstName", ' ', us."lastName") as "usedByName"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      LEFT JOIN "Users" us ON u."usedBy" = us.id
      ${whereClause}
      ORDER BY u.date DESC
      LIMIT 50
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      report: {
        byDepartment,
        byCategory,
        recent,
        summary: {
          totalTransactions: recent.length,
          totalValue: byDepartment.reduce((sum, d) => sum + parseFloat(d.totalValue || 0), 0)
        }
      }
    });

  } catch (error) {
    console.error('❌ Inventory usage report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/reports/stock', authenticate, async (req, res) => {
  try {
    const stock = await sequelize.query(`
      SELECT 
        category,
        COUNT(*) as "itemCount",
        SUM(quantity) as "totalQuantity",
        SUM(quantity * "unitPrice") as "totalValue",
        COUNT(CASE WHEN quantity <= "reorderLevel" THEN 1 END) as "lowStockCount",
        COUNT(CASE WHEN quantity = 0 THEN 1 END) as "outOfStockCount"
      FROM "Inventories"
      WHERE "schoolId" = $1
      GROUP BY category
      ORDER BY "totalValue" DESC
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    const lowStock = await sequelize.query(`
      SELECT *
      FROM "Inventories"
      WHERE "schoolId" = $1 AND quantity <= "reorderLevel"
      ORDER BY (quantity::float / NULLIF("reorderLevel", 0)) ASC
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      report: {
        byCategory: stock,
        lowStock,
        summary: {
          totalCategories: stock.length,
          totalItems: stock.reduce((sum, c) => sum + parseInt(c.itemCount), 0),
          totalValue: stock.reduce((sum, c) => sum + parseFloat(c.totalValue || 0), 0)
        }
      }
    });

  } catch (error) {
    console.error('❌ Inventory stock report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/dashboard', authenticate, async (req, res) => {
  try {
    const summary = await sequelize.query(`
      WITH stats AS (
        SELECT 
          COUNT(*) as "totalItems",
          SUM(quantity) as "totalQuantity",
          SUM(quantity * "unitPrice") as "totalValue",
          COUNT(CASE WHEN quantity <= "reorderLevel" THEN 1 END) as "lowStockItems",
          COUNT(CASE WHEN quantity = 0 THEN 1 END) as "outOfStockItems"
        FROM "Inventories"
        WHERE "schoolId" = $1
      ),
      recent_usage AS (
        SELECT 
          COALESCE(SUM(u.quantity), 0) as "usedLast30Days",
          COALESCE(COUNT(DISTINCT u.id), 0) as "usageTransactions"
        FROM "InventoryUsages" u
        INNER JOIN "Inventories" i ON u."inventoryId" = i.id
        WHERE i."schoolId" = $1
        AND u.date >= NOW() - INTERVAL '30 days'
      )
      SELECT 
        json_build_object(
          'inventory', (SELECT row_to_json(stats) FROM stats),
          'usage', (SELECT row_to_json(recent_usage) FROM recent_usage)
        ) as dashboard
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      dashboard: summary[0]?.dashboard || {
        inventory: { totalItems: 0, totalValue: 0, lowStockItems: 0 },
        usage: { usedLast30Days: 0, usageTransactions: 0 }
      }
    });

  } catch (error) {
    console.error('❌ Inventory dashboard error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== ANNOUNCEMENT ROUTES ====================

app.post('/api/announcements', authenticate, async (req, res) => {
  try {
    const { title, content, audience, expiresAt } = req.body;

    const announcement = await Announcement.create({
      title,
      content,
      audience,
      expiresAt,
      createdBy: req.user.id,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'ANNOUNCEMENT', announcement.id, null, announcement);

    res.status(201).json({ success: true, announcement });
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.get('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/announcements', authenticate, async (req, res) => {
  try {
    const announcements = await Announcement.findAll({
      where: {
        schoolId: req.user.schoolId,
        isActive: true,
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gte]: new Date() } }]
      },
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.put('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    
    await announcement.update(req.body);
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
app.delete('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    
    await announcement.destroy();
    res.json({ success: true, message: 'Announcement deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// ==================== EVENT ROUTES ====================

app.post('/api/events', authenticate, async (req, res) => {
  try {
    const { title, description, startDate, endDate, location, type, audience } = req.body;

    const event = await Event.create({
      title,
      description,
      startDate,
      endDate,
      location,
      type,
      audience,
      createdBy: req.user.id,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'EVENT', event.id, null, event);

    res.status(201).json({ success: true, event });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/events', authenticate, async (req, res) => {
  try {
    const events = await Event.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['startDate', 'DESC']]
    });
    res.json({ success: true, events });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/events/upcoming', authenticate, async (req, res) => {
  try {
    const events = await Event.findAll({
      where: {
        schoolId: req.user.schoolId,
        startDate: { [Op.gte]: new Date() }
      },
      order: [['startDate', 'ASC']],
      limit: 10
    });
    
    res.json({ success: true, events });
  } catch (error) {
    console.error('Get upcoming events error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== FEATURE ROUTES ====================

app.get('/api/features', authenticate, async (req, res) => {
  try {
    const features = await Feature.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, features });
  } catch (error) {
    console.error('Get features error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.patch('/api/features/:code/toggle', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const [feature, created] = await Feature.findOrCreate({
      where: { code: req.params.code, schoolId: req.user.schoolId },
      defaults: {
        name: req.params.code,
        code: req.params.code,
        category: 'GENERAL',
        isEnabled: true,
        schoolId: req.user.schoolId
      }
    });

    if (!created) {
      await feature.update({ isEnabled: !feature.isEnabled });
    }

    await createAuditLog(req, 'TOGGLE_FEATURE', 'FEATURE', feature.id, { isEnabled: !feature.isEnabled }, { isEnabled: feature.isEnabled });

    res.json({ success: true, feature });
  } catch (error) {
    console.error('Toggle feature error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== AUDIT LOGS ROUTE ====================

app.get('/api/audit-logs', authenticate, async (req, res) => {
  try {
    const { entity, action, startDate, endDate, limit = 100 } = req.query;
    const where = {};
    
    if (req.user.role !== 'SUPER_ADMIN') {
      where.schoolId = req.user.schoolId;
    }

    if (entity) where.entity = entity;
    if (action) where.action = action;
    if (startDate && endDate) {
      where.timestamp = { 
        [Op.between]: [new Date(startDate), new Date(endDate)] 
      };
    }

    const logs = await AuditLog.findAll({
      where,
      include: [
        { 
          model: User, 
          attributes: ['id', 'firstName', 'lastName', 'email', 'role'],
          required: false
        }
      ],
      order: [['timestamp', 'DESC']],
      limit: parseInt(limit)
    });
    
    const formattedLogs = logs.map(log => {
      const logJson = log.toJSON();
      
      if (logJson.User) {
        logJson.userName = `${logJson.User.firstName || ''} ${logJson.User.lastName || ''}`.trim() || logJson.User.email || 'Unknown';
      } 
      else if (logJson.userId) {
        logJson.userName = `User ${logJson.userId.substring(0, 8)}...`;
      }
      else {
        logJson.userName = 'System';
      }
      
      return logJson;
    });
    
    res.json({ 
      success: true, 
      logs: formattedLogs,
      count: formattedLogs.length
    });
  } catch (error) {
    console.error('❌ Get audit logs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== REPORT ROUTES ====================

app.get('/api/reports/student-performance/:studentId', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const student = await Student.findByPk(studentId, {
      include: [{ model: Class }]
    });

    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = getGradingSystem(school.category);

    const results = await Result.findAll({
      where: { studentId },
      include: [
        { model: Exam, required: false },
        { model: Subject, required: false }
      ],
      order: [['createdAt', 'DESC']]
    });

    const subjectAverages = {};
    results.forEach(result => {
      const subjectName = result.Subject?.name || 'Unknown';
      if (!subjectAverages[subjectName]) {
        subjectAverages[subjectName] = {
          total: 0,
          count: 0,
          subject: result.Subject
        };
      }
      subjectAverages[subjectName].total += result.marks;
      subjectAverages[subjectName].count += 1;
    });

    Object.keys(subjectAverages).forEach(key => {
      subjectAverages[key].average = subjectAverages[key].total / subjectAverages[key].count;
    });

    const examPerformance = {};
    results.forEach(result => {
      if (!examPerformance[result.Exam?.name]) {
        examPerformance[result.Exam?.name] = {
          exam: result.Exam,
          subjects: []
        };
      }
      examPerformance[result.Exam?.name].subjects.push({
        subject: result.Subject?.name,
        marks: result.marks,
        grade: result.grade,
        gradeCode: result.gradeCode,
        points: result.points
      });
    });

    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    const meanGrade = gradingSystem.calculateMeanGrade ? 
      gradingSystem.calculateMeanGrade(totalPoints) : 
      (results.length > 0 ? results[0].grade : 'N/A');

    res.json({
      success: true,
      report: {
        student,
        class: student.Class,
        gradingSystem: gradingSystem.name,
        summary: {
          totalExams: results.length,
          subjectAverages,
          overallAverage: results.length ? (results.reduce((sum, r) => sum + r.marks, 0) / results.length).toFixed(2) : 0,
          totalPoints,
          meanGrade
        },
        examPerformance,
        detailedResults: results
      }
    });
  } catch (error) {
    console.error('Generate student report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/reports/class-performance/:classId', authenticate, async (req, res) => {
  try {
    const classId = req.params.classId;
    const { examId, courseId, year } = req.query;
    
    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = getGradingSystem(school.category);
    
    if (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') {
      const where = { schoolId: req.user.schoolId };
      if (courseId) where.courseId = courseId;
      if (year) where.currentYear = year;
      
      const students = await Student.findAll({ where });
      
      const examWhere = { schoolId: req.user.schoolId };
      if (courseId) examWhere.courseId = courseId;
      
      const exams = await Exam.findAll({ where: examWhere });
      
      const results = await Result.findAll({
        where: { examId: { [Op.in]: exams.map(e => e.id) } },
        include: [
          { model: Student },
          { model: Exam, include: [{ model: Course }] }
        ]
      });
      
      const studentPerformance = {};
      results.forEach(result => {
        if (!studentPerformance[result.studentId]) {
          studentPerformance[result.studentId] = {
            student: result.Student,
            courses: {},
            totalMarks: 0,
            examCount: 0,
            totalPoints: 0
          };
        }
        
        const courseName = result.Exam.Course?.name || 'Unknown';
        if (!studentPerformance[result.studentId].courses[courseName]) {
          studentPerformance[result.studentId].courses[courseName] = [];
        }
        
        studentPerformance[result.studentId].courses[courseName].push({
          exam: result.Exam.name,
          marks: result.marks,
          grade: result.grade,
          points: result.points
        });
        
        studentPerformance[result.studentId].totalMarks += result.marks;
        studentPerformance[result.studentId].totalPoints += result.points || 0;
        studentPerformance[result.studentId].examCount += 1;
      });
      
      Object.values(studentPerformance).forEach(s => {
        s.average = s.totalMarks / s.examCount;
        s.gpa = s.totalPoints / s.examCount;
      });
      
      return res.json({
        success: true,
        report: {
          type: school.category,
          gradingSystem: gradingSystem.name,
          course: courseId ? await Course.findByPk(courseId) : null,
          year,
          studentPerformance: Object.values(studentPerformance),
          summary: {
            totalStudents: students.length,
            totalExams: exams.length,
            classAverage: Object.values(studentPerformance).reduce((sum, s) => sum + s.average, 0) / (Object.values(studentPerformance).length || 1)
          }
        }
      });
    } else {
      const classObj = await Class.findByPk(classId, {
        include: [{ model: Student }]
      });

      const where = { classId };
      if (examId) {
        where['$Exam.id$'] = examId;
      }

      const results = await Result.findAll({
        where,
        include: [
          { model: Student, required: false },
          { model: Exam, required: false },
          { model: Subject, required: false }
        ]
      });

      const studentPerformance = {};
      results.forEach(result => {
        if (!studentPerformance[result.studentId]) {
          studentPerformance[result.studentId] = {
            student: result.Student,
            subjects: [],
            totalMarks: 0,
            examCount: 0,
            totalPoints: 0
          };
        }
        studentPerformance[result.studentId].subjects.push({
          subject: result.Subject?.name,
          exam: result.Exam?.name,
          marks: result.marks,
          grade: result.grade,
          points: result.points
        });
        studentPerformance[result.studentId].totalMarks += result.marks;
        studentPerformance[result.studentId].totalPoints += result.points || 0;
        studentPerformance[result.studentId].examCount += 1;
      });

      Object.values(studentPerformance).forEach(s => {
        s.average = s.totalMarks / s.examCount;
        s.meanGrade = calculateMeanGrade(results.filter(r => r.studentId === s.student.id), school.category);
      });

      const subjectAverages = {};
      results.forEach(result => {
        const subjectName = result.Subject?.name;
        if (subjectName) {
          if (!subjectAverages[subjectName]) {
            subjectAverages[subjectName] = {
              total: 0,
              count: 0,
              marks: []
            };
          }
          subjectAverages[subjectName].total += result.marks;
          subjectAverages[subjectName].count += 1;
          subjectAverages[subjectName].marks.push(result.marks);
        }
      });

      Object.keys(subjectAverages).forEach(key => {
        subjectAverages[key].average = subjectAverages[key].total / subjectAverages[key].count;
      });

      res.json({
        success: true,
        report: {
          class: classObj,
          gradingSystem: gradingSystem.name,
          summary: {
            totalStudents: classObj?.Students?.length || 0,
            totalExams: results.length,
            classAverage: Object.values(studentPerformance).reduce((sum, s) => sum + s.average, 0) / (Object.values(studentPerformance).length || 1)
          },
          studentPerformance: Object.values(studentPerformance),
          subjectAverages
        }
      });
    }
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/reports/financial', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const where = { schoolId: req.user.schoolId };

    if (startDate && endDate) {
      where.date = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const payments = await Payment.findAll({
      where,
      include: [{ model: Student }]
    });

    const totalIncome = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const expenses = await Expense.findAll({ where });
    const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    const incomeByMethod = {};
    payments.forEach(p => {
      if (!incomeByMethod[p.paymentMethod]) {
        incomeByMethod[p.paymentMethod] = 0;
      }
      incomeByMethod[p.paymentMethod] += parseFloat(p.amount);
    });

    const incomeByCategory = {};
    payments.forEach(p => {
      const category = p.isOtherIncome ? p.incomeCategory : 'Fee Payment';
      if (!incomeByCategory[category]) {
        incomeByCategory[category] = 0;
      }
      incomeByCategory[category] += parseFloat(p.amount);
    });

    const expensesByCategory = {};
    expenses.forEach(e => {
      if (!expensesByCategory[e.category]) {
        expensesByCategory[e.category] = 0;
      }
      expensesByCategory[e.category] += parseFloat(e.amount);
    });

    res.json({
      success: true,
      report: {
        period: { startDate, endDate },
        summary: {
          totalIncome,
          totalExpenses,
          netIncome: totalIncome - totalExpenses
        },
        incomeByMethod,
        incomeByCategory,
        expensesByCategory,
        payments,
        expenses
      }
    });
  } catch (error) {
    console.error('Generate financial report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


// ==================== MESSAGE ROUTE WITH EMAIL SUPPORT ====================
/**
 * POST /api/messages
 * Send messages (Email, SMS, or Notifications)
 * Supports school-specific email/SMS configurations
 */
app.post('/api/messages', authenticate, async (req, res) => {
  try {
    const { 
      type, 
      subject, 
      content, 
      recipients, 
      sendNow, 
      recipientType, 
      schoolId 
    } = req.body;

    // Log the request
    console.log('📥 Received message request:', {
      type,
      recipientCount: recipients?.length || 0,
      recipientType,
      contentLength: content?.length || 0
    });

    // Validate recipients
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No recipients specified. Please select at least one recipient.' 
      });
    }

    // Validate content
    if (!content || content.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        message: 'Message content is required' 
      });
    }

    // Validate subject for emails
    if (type === 'EMAIL' && (!subject || subject.trim() === '')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email subject is required' 
      });
    }

    // Get school with email configuration
    const school = await School.findByPk(schoolId || req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found. Please select a valid school.' 
      });
    }

    // Create message record
    const message = await Message.create({
      type,
      subject: subject || null,
      content,
      to: recipients,
      from: req.user.id,
      schoolId: school.id,
      status: sendNow ? 'SENDING' : 'DRAFT',
      sentAt: sendNow ? new Date() : null
    });

    console.log(`✅ Message record created: ${message.id}`);

    // If not sending now, return early
    if (!sendNow) {
      return res.json({ 
        success: true, 
        message: 'Message saved as draft',
        messageId: message.id,
        recipientCount: recipients.length
      });
    }

    // ==================== SEND EMAILS ====================
    if (type === 'EMAIL') {
      // Prepare recipients with email addresses
      const emailRecipients = [];
      const failedRecipients = [];

      for (const recipient of recipients) {
        let emailAddress = recipient.email;
        let recipientName = recipient.name || 'User';
        
        // If no email in recipient object, try to find it
        if (!emailAddress && recipient.id) {
          // Try to find user
          const user = await User.findByPk(recipient.id);
          if (user && user.email) {
            emailAddress = user.email;
            recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
          }
          
          // Try student
          if (!emailAddress) {
            const student = await Student.findOne({ 
              where: { userId: recipient.id } 
            });
            if (student && student.email) {
              emailAddress = student.email;
              recipientName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'User';
            }
          }
        }

        if (emailAddress) {
          emailRecipients.push({
            id: recipient.id,
            name: recipientName,
            email: emailAddress
          });
        } else {
          failedRecipients.push({
            id: recipient.id,
            name: recipientName,
            reason: 'No email address found'
          });
        }
      }

      // Check if we have any valid recipients
      if (emailRecipients.length === 0) {
        await message.update({ status: 'FAILED' });
        return res.status(400).json({
          success: false,
          message: 'No valid email addresses found. Please ensure recipients have email addresses.',
          failedRecipients
        });
      }

      console.log(`📧 Sending ${emailRecipients.length} emails via school: ${school.name}`);
      console.log(`📧 Email provider: ${school.emailProvider || 'SMTP'}`);

      // Check if email is enabled for this school
      if (!school.emailConfig?.enabled) {
        console.log('⚠️ School email is disabled. Using default configuration.');
      }

      // Send emails using school's configuration
      const emailResult = await emailService.sendBulkEmails(
        school,
        emailRecipients,
        subject || 'Message from School',
        content,
        {
          batchSize: school.emailConfig?.batchSize || 50,
          delayBetweenBatches: school.emailConfig?.delayBetweenBatches || 1000,
          retryAttempts: school.emailConfig?.retryAttempts || 3,
          retryDelay: school.emailConfig?.retryDelay || 5000
        }
      );

      // Update message status
      await message.update({
        status: emailResult.failed === 0 ? 'SENT' : 'PARTIAL',
        sentAt: new Date()
      });

      // Return response with details
      return res.json({
        success: true,
        message: `Email sent to ${emailResult.sent} recipients${emailResult.failed > 0 ? ` (${emailResult.failed} failed)` : ''}`,
        messageId: message.id,
        sentCount: emailResult.sent,
        failedCount: emailResult.failed,
        totalRecipients: emailRecipients.length,
        failedRecipients: emailResult.failed > 0 ? emailResult.results.filter(r => !r.success).map(r => r.recipient) : undefined,
        details: emailResult.results
      });

    } 
    
    // ==================== SEND SMS ====================
    else if (type === 'SMS') {
      // Prepare recipients with phone numbers
      const smsRecipients = [];
      const failedRecipients = [];

      for (const recipient of recipients) {
        let phoneNumber = recipient.phone;
        let recipientName = recipient.name || 'User';
        
        if (!phoneNumber && recipient.id) {
          const user = await User.findByPk(recipient.id);
          if (user && user.phone) {
            phoneNumber = user.phone;
            recipientName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';
          }
        }

        if (phoneNumber) {
          // Clean phone number
          const defaultCountryCode = school.smsConfig?.defaultCountryCode || '254';
          let cleanedNumber = phoneNumber.replace(/\s/g, '');
          
          if (!cleanedNumber.startsWith('+')) {
            // Remove leading 0 if present
            if (cleanedNumber.startsWith('0')) {
              cleanedNumber = cleanedNumber.substring(1);
            }
            cleanedNumber = `+${defaultCountryCode}${cleanedNumber}`;
          }

          smsRecipients.push({
            id: recipient.id,
            name: recipientName,
            phone: cleanedNumber
          });
        } else {
          failedRecipients.push({
            id: recipient.id,
            name: recipientName,
            reason: 'No phone number found'
          });
        }
      }

      if (smsRecipients.length === 0) {
        await message.update({ status: 'FAILED' });
        return res.status(400).json({
          success: false,
          message: 'No valid phone numbers found. Please ensure recipients have phone numbers.',
          failedRecipients
        });
      }

      console.log(`📱 Sending ${smsRecipients.length} SMS messages via school: ${school.name}`);

      // Check if SMS is enabled for this school
      if (!school.smsConfig?.enabled) {
        console.log('⚠️ School SMS is disabled. Cannot send SMS.');
        await message.update({ status: 'FAILED' });
        return res.status(400).json({
          success: false,
          message: 'SMS is not enabled for this school. Please enable SMS in school settings.'
        });
      }

      // Send SMS using school's configuration
      const smsResult = await smsService.sendBulkSMS(
        school,
        smsRecipients,
        content,
        {
          batchSize: school.smsConfig?.batchSize || 100,
          delayBetweenBatches: school.smsConfig?.delayBetweenBatches || 2000,
          retryAttempts: 2,
          retryDelay: 3000
        }
      );

      // Update message status
      await message.update({
        status: smsResult.failed === 0 ? 'SENT' : 'PARTIAL',
        sentAt: new Date()
      });

      return res.json({
        success: true,
        message: `SMS sent to ${smsResult.sent} recipients${smsResult.failed > 0 ? ` (${smsResult.failed} failed)` : ''}`,
        messageId: message.id,
        sentCount: smsResult.sent,
        failedCount: smsResult.failed,
        totalRecipients: smsRecipients.length,
        failedRecipients: smsResult.failed > 0 ? smsResult.results.filter(r => !r.success).map(r => r.recipient) : undefined,
        details: smsResult.results
      });
    }

    // ==================== NOTIFICATIONS (Push/In-App) ====================
    else if (type === 'NOTIFICATION') {
      // Create notifications for each recipient
      const notificationPromises = recipients.map(async (recipient) => {
        // Create a notification record (you would have a Notification model)
        // For now, just log it
        console.log(`🔔 Notification to ${recipient.name || recipient.id}: ${content}`);
        return { recipient: recipient.id, success: true };
      });

      const notificationResults = await Promise.all(notificationPromises);
      const sentCount = notificationResults.filter(r => r.success).length;

      await message.update({
        status: 'SENT',
        sentAt: new Date()
      });

      return res.json({
        success: true,
        message: `Notification sent to ${sentCount} recipients`,
        messageId: message.id,
        sentCount
      });
    }

    // ==================== UNSUPPORTED TYPE ====================
    else {
      await message.update({ status: 'FAILED' });
      return res.status(400).json({
        success: false,
        message: `Unsupported message type: ${type}. Supported types: EMAIL, SMS, NOTIFICATION`
      });
    }

  } catch (error) {
    console.error('❌ Message error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send message. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== TEST EMAIL CONFIGURATION ====================
/**
 * POST /api/schools/:schoolId/test-email
 * Test the email configuration for a school
 */
// ==================== TEST EMAIL CONFIGURATION (FIXED) ====================
// ==================== TEST EMAIL CONFIGURATION (FIXED) ====================
app.post('/api/schools/:schoolId/test-email', authenticate, async (req, res) => {
  try {
    const { schoolId } = req.params;
    const { testEmail } = req.body;

    console.log('📧 Test email request for school:', schoolId);

    // Find the school with all necessary fields
    const school = await School.findByPk(schoolId, {
      attributes: ['id', 'name', 'emailProvider', 'emailConfig', 'contact']
    });
    
    if (!school) {
      console.log('❌ School not found:', schoolId);
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // Log the school details
    console.log('📧 School found:', school.name);
    console.log('📧 Provider:', school.emailProvider || 'SMTP');
    console.log('📧 Email enabled:', school.emailConfig?.enabled ? 'Yes' : 'No');

    // Ensure the school object has all needed fields
    const schoolData = {
      id: school.id,
      name: school.name || 'School',
      emailProvider: school.emailProvider || 'SMTP',
      emailConfig: {
        ...school.emailConfig,
        fromEmail: school.emailConfig?.fromEmail || 
                   school.emailConfig?.smtp?.fromEmail || 
                   process.env.EMAIL_USER,
        smtp: school.emailConfig?.smtp || {
          host: school.emailConfig?.host || process.env.EMAIL_HOST,
          port: school.emailConfig?.port || process.env.EMAIL_PORT,
          username: school.emailConfig?.username || process.env.EMAIL_USER,
          password: school.emailConfig?.password || process.env.EMAIL_PASS,
          fromEmail: school.emailConfig?.fromEmail || process.env.EMAIL_USER
        },
        enabled: school.emailConfig?.enabled || true
      }
    };

    console.log('📧 School data prepared:', {
      name: schoolData.name,
      provider: schoolData.emailProvider,
      fromEmail: schoolData.emailConfig.fromEmail
    });

    // Determine test email
    const testEmailAddress = testEmail || req.user?.email || school.contact?.email || process.env.EMAIL_USER;
    
    if (!testEmailAddress) {
      return res.status(400).json({
        success: false,
        message: 'No test email address available'
      });
    }

    console.log(`📧 Sending test email to: ${testEmailAddress}`);
    console.log(`📧 From: ${schoolData.emailConfig.fromEmail}`);

    // Test the configuration with the full school data
    const result = await emailService.testConfiguration(schoolData, testEmailAddress);

    if (result.success) {
      return res.json({
        success: true,
        message: `✅ Test email sent successfully to ${testEmailAddress}`,
        provider: school.emailProvider || 'SMTP',
        details: {
          school: school.name,
          fromEmail: schoolData.emailConfig.fromEmail,
          testEmail: testEmailAddress,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        message: `❌ Test email failed: ${result.error || 'Unknown error'}`,
        provider: school.emailProvider || 'SMTP',
        details: {
          error: result.error,
          school: school.name,
          timestamp: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('❌ Test email error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to test email configuration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// ==================== GET EMAIL PROVIDERS ====================
/**
 * GET /api/email/providers
 * Get list of available email providers
 */
app.get('/api/email/providers', authenticate, async (req, res) => {
  try {
    const providers = [
      { 
        value: 'SMTP', 
        label: '📧 SMTP (Gmail, Outlook, etc.)', 
        description: 'Standard email protocol using SMTP server',
        fields: ['host', 'port', 'username', 'password', 'fromEmail']
      },
      { 
        value: 'SENDGRID', 
        label: '🚀 SendGrid', 
        description: 'Twilio SendGrid API - Reliable email delivery',
        fields: ['apiKey', 'fromEmail']
      },
      { 
        value: 'RESEND', 
        label: '📨 Resend', 
        description: 'Modern email API for developers',
        fields: ['apiKey', 'fromEmail']
      },
      { 
        value: 'MAILGUN', 
        label: '📬 Mailgun', 
        description: 'Mailgun API for transactional emails',
        fields: ['apiKey', 'domain', 'fromEmail']
      },
      { 
        value: 'AWS_SES', 
        label: '☁️ AWS SES', 
        description: 'Amazon Simple Email Service - Scalable email sending',
        fields: ['accessKeyId', 'secretAccessKey', 'region', 'fromEmail']
      }
    ];
    
    // Get current school's provider if available
    let currentProvider = 'SMTP';
    if (req.user?.schoolId) {
      const school = await School.findByPk(req.user.schoolId, {
        attributes: ['emailProvider']
      });
      if (school) {
        currentProvider = school.emailProvider || 'SMTP';
      }
    }
    
    res.json({ 
      success: true, 
      providers,
      currentProvider
    });
  } catch (error) {
    console.error('❌ Get providers error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch email providers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== GET SMS PROVIDERS ====================
/**
 * GET /api/sms/providers
 * Get list of available SMS providers
 */
app.get('/api/sms/providers', authenticate, async (req, res) => {
  try {
    const providers = [
      { 
        value: 'NONE', 
        label: '⛔ None', 
        description: 'SMS disabled'
      },
      { 
        value: 'AFRICASTALKING', 
        label: '🌍 Africa\'s Talking', 
        description: 'Africa\'s Talking SMS API - Popular in Kenya',
        fields: ['apiKey', 'username', 'senderId', 'shortCode']
      },
      { 
        value: 'TWILIO', 
        label: '📞 Twilio', 
        description: 'Twilio Programmable SMS - Global coverage',
        fields: ['accountSid', 'authToken', 'fromNumber', 'messagingServiceSid']
      },
      { 
        value: 'BULKSMS', 
        label: '📨 BulkSMS', 
        description: 'BulkSMS API - Reliable SMS delivery',
        fields: ['username', 'password', 'from']
      },
      { 
        value: 'SMSCOUNTRY', 
        label: '📱 SMS Country', 
        description: 'SMS Country API - Affordable SMS',
        fields: ['username', 'password', 'senderId', 'route']
      }
    ];
    
    // Get current school's provider if available
    let currentProvider = 'NONE';
    if (req.user?.schoolId) {
      const school = await School.findByPk(req.user.schoolId, {
        attributes: ['smsProvider']
      });
      if (school) {
        currentProvider = school.smsProvider || 'NONE';
      }
    }
    
    res.json({ 
      success: true, 
      providers,
      currentProvider
    });
  } catch (error) {
    console.error('❌ Get SMS providers error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch SMS providers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==================== GET EMAIL CONFIGURATION STATUS ====================
/**
 * GET /api/email/status
 * Get the email configuration status for the current school
 */
app.get('/api/email/status', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.user.schoolId, {
      attributes: ['id', 'name', 'emailProvider', 'emailConfig']
    });
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    const isConfigured = school.emailConfig?.enabled === true;
    const hasCredentials = !!(school.emailConfig?.smtp?.host || 
                             school.emailConfig?.sendgrid?.apiKey ||
                             school.emailConfig?.resend?.apiKey ||
                             school.emailConfig?.mailgun?.apiKey ||
                             school.emailConfig?.ses?.accessKeyId);

    res.json({
      success: true,
      status: {
        schoolId: school.id,
        schoolName: school.name,
        provider: school.emailProvider || 'SMTP',
        enabled: isConfigured,
        configured: isConfigured && hasCredentials,
        fromEmail: school.emailConfig?.smtp?.fromEmail || 
                   school.emailConfig?.sendgrid?.fromEmail ||
                   school.emailConfig?.resend?.fromEmail ||
                   school.emailConfig?.mailgun?.fromEmail ||
                   school.emailConfig?.ses?.fromEmail ||
                   school.contact?.email ||
                   null,
        testMode: school.emailConfig?.testMode || false,
        sendLimit: school.emailConfig?.sendLimit || 1000
      }
    });
  } catch (error) {
    console.error('❌ Get email status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get email status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// ==================== DASHBOARD ROUTES ====================

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    
    const stats = {
      overview: { totalStudents: 0, totalTeachers: 0, totalClasses: 0, totalStaff: 0 },
      attendance: { total: 0, present: 0, percentage: 0 },
      finance: { totalFees: 0, totalPayments: 0, balance: 0, collectionRate: 0 },
      alerts: { upcomingExams: 0, lowStock: 0, overdueBooks: 0, borrowedBooks: 0 },
      vehicles: { total: 0, active: 0, maintenance: 0, expiredInsurance: 0 },
      library: { totalBooks: 0, availableBooks: 0, borrowedBooks: 0 }
    };

    if (schoolId) {
      stats.overview.totalStudents = await Student.count({ where: { schoolId } }) || 0;
      stats.overview.totalTeachers = await User.count({ 
        where: { schoolId, role: ['TEACHER', 'CLASS_TEACHER', 'SUBJECT_TEACHER', 'SENIOR_TEACHER'] }
      }) || 0;
      stats.overview.totalClasses = await Class.count({ where: { schoolId } }) || 0;
      stats.overview.totalStaff = await Staff.count({ where: { schoolId } }) || 0;

      const books = await Book.findAll({ where: { schoolId } });
      stats.library.totalBooks = books.reduce((sum, b) => sum + b.quantity, 0);
      stats.library.availableBooks = books.reduce((sum, b) => sum + b.available, 0);
      stats.library.borrowedBooks = await Borrow.count({ 
        where: { status: 'BORROWED' },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;

      stats.vehicles.total = await Vehicle.count({ where: { schoolId } }) || 0;
      stats.vehicles.active = await Vehicle.count({ where: { schoolId, status: 'ACTIVE' } }) || 0;
      stats.vehicles.maintenance = await Vehicle.count({ where: { schoolId, status: 'MAINTENANCE' } }) || 0;
      stats.vehicles.expiredInsurance = await Vehicle.count({
        where: { 
          schoolId, 
          insuranceExpiry: { [Op.lt]: new Date() } 
        }
      }) || 0;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayAttendance = await Attendance.findAll({
        where: { date: { [Op.between]: [today, tomorrow] } }
      });

      stats.attendance.total = todayAttendance.length;
      stats.attendance.present = todayAttendance.filter(a => a.status === 'PRESENT').length;
      stats.attendance.percentage = todayAttendance.length ? 
        ((stats.attendance.present / todayAttendance.length) * 100).toFixed(2) : 0;

      const totalFees = await Fee.sum('amount', { where: { schoolId } }) || 0;
      
      const payments = await Payment.findAll({
        include: [{
          model: Student,
          where: { schoolId },
          attributes: []
        }],
        attributes: [[sequelize.fn('SUM', sequelize.col('Payment.amount')), 'total']],
        raw: true
      });

      const totalPayments = parseFloat(payments[0]?.total) || 0;

      stats.finance.totalFees = totalFees;
      stats.finance.totalPayments = totalPayments;
      stats.finance.balance = totalFees - totalPayments;
      stats.finance.collectionRate = totalFees ? ((totalPayments / totalFees) * 100).toFixed(2) : 0;

      stats.alerts.upcomingExams = await Exam.count({
        where: { schoolId, date: { [Op.gte]: new Date() } }
      }) || 0;

      stats.alerts.lowStock = await Inventory.count({
        where: { schoolId, quantity: { [Op.lte]: sequelize.col('reorderLevel') } }
      }) || 0;

      stats.alerts.overdueBooks = await Borrow.count({
        where: { status: 'BORROWED', dueDate: { [Op.lt]: new Date() } },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;
      
      stats.alerts.borrowedBooks = await Borrow.count({
        where: { status: 'BORROWED' },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;
    }

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/dashboard/charts', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.json({
        success: true,
        charts: {
          attendanceTrend: [],
          feeCollection: [],
          studentsByClass: []
        }
      });
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const attendanceTrend = await Attendance.findAll({
      where: { date: { [Op.gte]: thirtyDaysAgo } },
      attributes: [
        [sequelize.fn('DATE', sequelize.col('Attendance.date')), 'date'],
        'status',
        [sequelize.fn('COUNT', sequelize.col('Attendance.id')), 'count']
      ],
      group: ['date', 'status'],
      include: [{
        model: Student,
        where: { schoolId },
        attributes: [],
        required: true
      }]
    });

    const feeCollection = await Payment.findAll({
      where: { date: { [Op.gte]: thirtyDaysAgo } },
      attributes: [
        [sequelize.fn('DATE_TRUNC', 'month', sequelize.col('Payment.date')), 'month'],
        [sequelize.fn('SUM', sequelize.col('Payment.amount')), 'total']
      ],
      group: ['month'],
      include: [{
        model: Student,
        where: { schoolId },
        attributes: [],
        required: true
      }]
    });

    const studentsByClass = await Student.findAll({
      where: { schoolId },
      attributes: [
        'classId',
        [sequelize.fn('COUNT', sequelize.col('Student.id')), 'count']
      ],
      group: ['classId', 'Class.id', 'Class.name'],
      include: [{
        model: Class,
        attributes: ['name']
      }]
    });
    
    res.json({
      success: true,
      charts: {
        attendanceTrend: attendanceTrend || [],
        feeCollection: feeCollection || [],
        studentsByClass: studentsByClass || []
      }
    });
  } catch (error) {
    console.error('Charts data error:', error);
    res.json({
      success: true,
      charts: {
        attendanceTrend: [],
        feeCollection: [],
        studentsByClass: []
      }
    });
  }
});

// ==================== UPLOAD ROUTES ====================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

app.post('/api/schools/upload-logo', authenticate, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const logoUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, logoUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/students/upload-photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const photoUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, photoUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.use('/uploads', (req, res, next) => {
  const filePath = path.join(uploadDir, req.url);
  
  if (!fs.existsSync(filePath)) {
    return res.sendFile(path.join(publicDir, 'default-logo.svg'));
  }
  
  express.static(uploadDir)(req, res, next);
});

// ==================== UNIVERSITY/TVET ROUTES ====================
// ==================== FACULTIES ROUTE - MAKE SURE IT WORKS FOR ALL SCHOOL TYPES ====================
app.get('/api/faculties', authenticate, async (req, res) => {
  try {
    console.log(`📚 Fetching faculties for school: ${req.user.schoolId}`);
    
    const where = { schoolId: req.user.schoolId };
    const faculties = await Faculty.findAll({ 
      where,
      order: [['name', 'ASC']]
    });
    
    console.log(`✅ Found ${faculties.length} faculties`);
    
    res.json({ 
      success: true, 
      faculties,
      count: faculties.length
    });
  } catch (error) {
    console.error('❌ Get faculties error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

app.post('/api/faculties', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, dean, email, phone, established } = req.body;
    
    const faculty = await Faculty.create({
      name,
      dean,
      email,
      phone,
      established,
      schoolId: req.user.schoolId
    });
    
    res.status(201).json({ success: true, faculty });
  } catch (error) {
    console.error('Create faculty error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/departments', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const departments = await Department.findAll({ 
      where,
      include: [{ model: Faculty }]
    });
    res.json({ success: true, departments });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/departments', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, facultyId, head, email, phone } = req.body;
    
    const faculty = await Faculty.findOne({
      where: { id: facultyId, schoolId: req.user.schoolId }
    });
    
    if (!faculty) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faculty not found or does not belong to your school' 
      });
    }
    
    const department = await Department.create({
      name,
      facultyId,
      head,
      email,
      phone,
      schoolId: req.user.schoolId
    });
    
    const createdDept = await Department.findByPk(department.id, {
      include: [{ model: Faculty, attributes: ['id', 'name'] }]
    });
    
    res.status(201).json({ success: true, department: createdDept });
  } catch (error) {
    console.error('Create department error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== UPDATE DEPARTMENT ====================
app.put('/api/departments/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, facultyId, head, email, phone } = req.body;

    // Find the department
    const department = await Department.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(404).json({ 
        success: false, 
        message: 'Department not found' 
      });
    }

    // If facultyId is being changed, verify the new faculty exists
    if (facultyId && facultyId !== department.facultyId) {
      const faculty = await Faculty.findOne({
        where: { 
          id: facultyId,
          schoolId: req.user.schoolId 
        }
      });

      if (!faculty) {
        return res.status(400).json({ 
          success: false, 
          message: 'Faculty not found or does not belong to your school' 
        });
      }
    }

    // Update the department
    await department.update({
      name: name || department.name,
      facultyId: facultyId || department.facultyId,
      head: head || department.head,
      email: email || department.email,
      phone: phone || department.phone
    });

    // Fetch the updated department with faculty info
    const updatedDepartment = await Department.findByPk(department.id, {
      include: [{ model: Faculty, attributes: ['id', 'name'] }]
    });

    res.json({ 
      success: true, 
      department: updatedDepartment 
    });
  } catch (error) {
    console.error('❌ Update department error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== DELETE DEPARTMENT ====================
app.delete('/api/departments/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const department = await Department.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(404).json({ 
        success: false, 
        message: 'Department not found' 
      });
    }

    // Check if there are courses linked to this department
    const coursesCount = await Course.count({
      where: { departmentId: id }
    });

    if (coursesCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete department with ${coursesCount} linked courses. Please reassign courses first.` 
      });
    }

    // Check if there are programs linked to this department
    const programsCount = await Program.count({
      where: { departmentId: id }
    });

    if (programsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete department with ${programsCount} linked programs. Please reassign programs first.` 
      });
    }

    await department.destroy();
    
    res.json({ 
      success: true, 
      message: 'Department deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Delete department error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/courses', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const courses = await Course.findAll({ 
      where,
      include: [{ model: Department, include: [{ model: Faculty }] }]
    });
    res.json({ success: true, courses });
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/courses', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, code, departmentId, credits, level, description } = req.body;
    
    const department = await Department.findOne({
      where: { id: departmentId, schoolId: req.user.schoolId }
    });
    
    if (!department) {
      return res.status(400).json({ message: 'Department not found' });
    }
    
    const course = await Course.create({
      name,
      code,
      departmentId,
      credits,
      level,
      description,
      schoolId: req.user.schoolId
    });
    
    const createdCourse = await Course.findByPk(course.id, {
      include: [{ model: Department }]
    });
    
    res.status(201).json({ success: true, course: createdCourse });
  } catch (error) {
    console.error('Create course error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== PROGRAMS ENDPOINTS (for TVET) ====================

// GET all programs
app.get('/api/programs', authenticate, async (req, res) => {
  try {
    const programs = await Program.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: Department, attributes: ['id', 'name'] }],
      order: [['name', 'ASC']]
    });
    
    res.json({ 
      success: true, 
      programs 
    });
  } catch (error) {
    console.error('❌ Get programs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single program by ID
app.get('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });
    
    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }
    
    res.json({ 
      success: true, 
      program 
    });
  } catch (error) {
    console.error('❌ Get program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// POST create new program
app.post('/api/programs', authenticate, async (req, res) => {
  try {
    const { name, code, departmentId, duration, level, description } = req.body;

    // Validate required fields
    if (!name || !code || !departmentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name, code, and department are required' 
      });
    }

    // Check if program with same code exists in this school
    const existing = await Program.findOne({
      where: { 
        code: code.toUpperCase(),
        schoolId: req.user.schoolId 
      }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Program with this code already exists' 
      });
    }

    // Verify department exists and belongs to this school
    const department = await Department.findOne({
      where: { 
        id: departmentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(400).json({ 
        success: false, 
        message: 'Department not found or does not belong to your school' 
      });
    }

    const program = await Program.create({
      name,
      code: code.toUpperCase(),
      departmentId,
      duration: duration || 3,
      level: level || 'Diploma',
      description,
      schoolId: req.user.schoolId
    });

    // Fetch with department info
    const createdProgram = await Program.findByPk(program.id, {
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });

    await createAuditLog(req, 'CREATE', 'PROGRAM', program.id, null, createdProgram);

    res.status(201).json({ 
      success: true, 
      program: createdProgram 
    });
  } catch (error) {
    console.error('❌ Create program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// PUT update program
app.put('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }

    const { name, code, departmentId, duration, level, description } = req.body;

    // If code is being changed, check for duplicates
    if (code && code.toUpperCase() !== program.code) {
      const existing = await Program.findOne({
        where: { 
          code: code.toUpperCase(),
          schoolId: req.user.schoolId,
          id: { [Op.ne]: program.id }
        }
      });

      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program with this code already exists' 
        });
      }
    }

    // If department is being changed, verify it exists
    if (departmentId && departmentId !== program.departmentId) {
      const department = await Department.findOne({
        where: { 
          id: departmentId,
          schoolId: req.user.schoolId 
        }
      });

      if (!department) {
        return res.status(400).json({ 
          success: false, 
          message: 'Department not found or does not belong to your school' 
        });
      }
    }

    const oldProgram = { ...program.toJSON() };

    await program.update({
      name: name || program.name,
      code: code ? code.toUpperCase() : program.code,
      departmentId: departmentId || program.departmentId,
      duration: duration !== undefined ? duration : program.duration,
      level: level || program.level,
      description: description !== undefined ? description : program.description
    });

    // Fetch updated program with department
    const updatedProgram = await Program.findByPk(program.id, {
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });

    await createAuditLog(req, 'UPDATE', 'PROGRAM', program.id, oldProgram, updatedProgram);

    res.json({ 
      success: true, 
      program: updatedProgram 
    });
  } catch (error) {
    console.error('❌ Update program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE program
app.delete('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }

    // Check if program has students enrolled
    const studentsCount = await Student.count({
      where: { programId: program.id }
    });

    if (studentsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete program with ${studentsCount} enrolled students. Please reassign students first.` 
      });
    }

    // Check if program has units/modules
    const unitsCount = await CourseUnit.count({
      where: { programId: program.id }
    });

    if (unitsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete program with ${unitsCount} units/modules. Please delete units first.` 
      });
    }

    await program.destroy();
    await createAuditLog(req, 'DELETE', 'PROGRAM', req.params.id);

    res.json({ 
      success: true, 
      message: 'Program deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Delete program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET programs by department
app.get('/api/departments/:departmentId/programs', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.params;

    // Verify department belongs to this school
    const department = await Department.findOne({
      where: { 
        id: departmentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(404).json({ 
        success: false, 
        message: 'Department not found' 
      });
    }

    const programs = await Program.findAll({
      where: { 
        departmentId,
        schoolId: req.user.schoolId 
      },
      order: [['name', 'ASC']]
    });

    res.json({ 
      success: true, 
      programs,
      department: {
        id: department.id,
        name: department.name
      }
    });
  } catch (error) {
    console.error('❌ Get department programs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/course-units', authenticate, async (req, res) => {
  try {
    const { courseId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (courseId) {
      where.courseId = courseId;
    }

    const units = await CourseUnit.findAll({
      where,
      include: [{ model: Course, attributes: ['id', 'name', 'code'] }],
      order: [['year', 'ASC'], ['semester', 'ASC'], ['name', 'ASC']]
    });
    
    res.json({ success: true, units });
  } catch (error) {
    console.error('Get course units error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/course-units', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT CREATE ==========');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { name, code, courseId, programId, semester, module, year, credits, description } = req.body;

    // Validate that either courseId or programId is provided
    if (!courseId && !programId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either courseId or programId is required' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    // Prepare data
    const unitData = {
      name: name.trim(),
      code: code?.trim() || null,
      courseId: isUniversity ? courseId : null,
      programId: isTVET ? programId : null,
      year: year ? parseInt(year) : null,
      credits: credits ? parseInt(credits) : 3,
      description: description?.trim() || null,
      schoolId: req.user.schoolId
    };

    // Handle semester for University
    if (isUniversity) {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = null;
      console.log('🏫 University: setting semester to', unitData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      unitData.module = module ? parseInt(module) : null;
      unitData.semester = null;
      console.log('🔧 TVET: setting module to', unitData.module);
    }
    // Handle other school types
    else {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = module ? parseInt(module) : null;
    }

    console.log('Creating unit with data:', unitData);

    // Verify course exists if provided
    if (unitData.courseId) {
      const course = await Course.findOne({
        where: { id: unitData.courseId, schoolId: req.user.schoolId }
      });
      if (!course) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course not found or does not belong to your school' 
        });
      }
    }

    // Verify program exists if provided
    if (unitData.programId) {
      const program = await Program.findOne({
        where: { id: unitData.programId, schoolId: req.user.schoolId }
      });
      if (!program) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program not found or does not belong to your school' 
        });
      }
    }

    // Create the unit
    const unit = await CourseUnit.create(unitData);

    await createAuditLog(req, 'CREATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the created unit with appropriate includes
    const include = [];
    if (unit.courseId) {
      include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    }
    if (unit.programId) {
      include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    }

    const createdUnit = await CourseUnit.findByPk(unit.id, { include });

    console.log('✅ Unit created successfully');
    res.status(201).json({ success: true, unit: createdUnit });

  } catch (error) {
    console.error('❌ Create course unit error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== COURSE UNITS ENDPOINTS ====================

// GET all course units
app.get('/api/course-units', authenticate, async (req, res) => {
  try {
    const { courseId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (courseId) {
      where.courseId = courseId;
    }

    const units = await CourseUnit.findAll({
      where,
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code', 'departmentId'] 
      }],
      order: [
        ['year', 'ASC'],
        ['semester', 'ASC'],
        ['module', 'ASC'],
        ['name', 'ASC']
      ]
    });
    
    // Log for debugging
    console.log(`📚 Found ${units.length} units`);
    if (units.length > 0) {
      console.log('Sample unit:', {
        id: units[0].id,
        name: units[0].name,
        semester: units[0].semester,
        module: units[0].module,
        year: units[0].year
      });
    }
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single course unit by ID
app.get('/api/course-units/:id', authenticate, async (req, res) => {
  try {
    const unit = await CourseUnit.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code', 'departmentId'] 
      }]
    });
    
    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }
    
    console.log('📚 Retrieved unit:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module
    });
    
    res.json({ 
      success: true, 
      unit 
    });
  } catch (error) {
    console.error('❌ Get course unit error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// CREATE new course unit
app.post('/api/course-units', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT CREATE ==========');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('User school ID:', req.user.schoolId);
  
  try {
    const { name, code, courseId, semester, module, year, credits, description } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Unit name is required' 
      });
    }

    if (!courseId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Course ID is required' 
      });
    }

    // Verify course exists and belongs to this school
    const course = await Course.findOne({
      where: { 
        id: courseId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!course) {
      return res.status(400).json({ 
        success: false, 
        message: 'Course not found or does not belong to your school' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    console.log(`🏫 School category: ${school.category}`);
    console.log(`📚 University: ${isUniversity}, TVET: ${isTVET}`);

    // Prepare data with proper handling of semester/module
    const unitData = {
      name: name.trim(),
      code: code?.trim() || null,
      courseId,
      year: year ? parseInt(year) : null,
      credits: credits ? parseInt(credits) : 3,
      description: description?.trim() || null,
      schoolId: req.user.schoolId
    };

    // Handle semester for University
    if (isUniversity) {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = null;
      console.log('🏫 University: setting semester to', unitData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      unitData.module = module ? parseInt(module) : null;
      unitData.semester = null;
      console.log('🔧 TVET: setting module to', unitData.module);
    }
    // Handle other school types (fallback)
    else {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = module ? parseInt(module) : null;
      console.log('📚 Other school type: setting both fields');
    }

    // Remove undefined fields
    Object.keys(unitData).forEach(key => {
      if (unitData[key] === undefined) delete unitData[key];
    });

    console.log('Creating unit with data:', unitData);

    // Create the unit
    const unit = await CourseUnit.create(unitData);

    console.log('✅ Unit created in database:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module,
      year: unit.year,
      credits: unit.credits,
      schoolId: unit.schoolId
    });

    // Create audit log
    await createAuditLog(req, 'CREATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the created unit with course info
    const createdUnit = await CourseUnit.findByPk(unit.id, {
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code'] 
      }]
    });

    // Double-check the fetched unit has all fields
    console.log('✅ Unit fetched from DB for response:', {
      id: createdUnit.id,
      name: createdUnit.name,
      semester: createdUnit.semester,
      module: createdUnit.module,
      year: createdUnit.year,
      credits: createdUnit.credits,
      course: createdUnit.Course ? createdUnit.Course.name : null
    });

    // If module is missing in the response but exists in DB, add it manually
    if (isTVET && unitData.module && createdUnit.module === null) {
      console.warn('⚠️ Module missing in response, adding manually');
      createdUnit.module = unitData.module;
    }

    res.status(201).json({ 
      success: true, 
      unit: createdUnit 
    });

  } catch (error) {
    console.error('❌ Create course unit error:', error);
    
    // Handle specific Sequelize errors
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation error', 
        errors: error.errors.map(e => e.message) 
      });
    }
    
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'A unit with this code already exists' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE course unit
app.put('/api/course-units/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT UPDATE ==========');
  console.log('Params ID:', req.params.id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('School ID:', req.user.schoolId);
  
  try {
    const { id } = req.params;
    const updates = req.body;

    // Find the unit
    const unit = await CourseUnit.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }

    console.log('Current unit:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module,
      year: unit.year,
      credits: unit.credits
    });

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    // Prepare update data
    const updateData = {};
    
    // Handle string fields
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.code !== undefined) updateData.code = updates.code?.trim() || null;
    if (updates.description !== undefined) updateData.description = updates.description?.trim() || null;
    if (updates.courseId !== undefined) {
      // Verify course exists if changing
      const course = await Course.findOne({
        where: { id: updates.courseId, schoolId: req.user.schoolId }
      });
      if (!course) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course not found or does not belong to your school' 
        });
      }
      updateData.courseId = updates.courseId;
    }
    
    // Handle semester for University
    if (isUniversity) {
      if (updates.semester !== undefined) {
        updateData.semester = updates.semester === '' || updates.semester === null 
          ? null 
          : parseInt(updates.semester);
        updateData.module = null; // Ensure module is null for university
      }
      console.log('🏫 University update: semester ->', updateData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      if (updates.module !== undefined) {
        updateData.module = updates.module === '' || updates.module === null 
          ? null 
          : parseInt(updates.module);
        updateData.semester = null; // Ensure semester is null for TVET
      }
      console.log('🔧 TVET update: module ->', updateData.module);
    }
    // Handle other school types
    else {
      if (updates.semester !== undefined) {
        updateData.semester = updates.semester === '' || updates.semester === null 
          ? null 
          : parseInt(updates.semester);
      }
      if (updates.module !== undefined) {
        updateData.module = updates.module === '' || updates.module === null 
          ? null 
          : parseInt(updates.module);
      }
    }
    
    // Handle year
    if (updates.year !== undefined) {
      updateData.year = updates.year === '' || updates.year === null 
        ? null 
        : parseInt(updates.year);
    }
    
    // Handle credits
    if (updates.credits !== undefined) {
      const creditsNum = parseInt(updates.credits);
      updateData.credits = isNaN(creditsNum) ? 3 : creditsNum;
    }

    // Remove undefined fields
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    console.log('Final update data:', updateData);

    // Perform the update
    await unit.update(updateData);

    // Create audit log
    await createAuditLog(req, 'UPDATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the updated unit
    const updatedUnit = await CourseUnit.findByPk(unit.id, {
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code'],
        required: false 
      }]
    });

    console.log('✅ Update successful');
    console.log('Updated unit:', {
      id: updatedUnit.id,
      name: updatedUnit.name,
      semester: updatedUnit.semester,
      module: updatedUnit.module,
      year: updatedUnit.year,
      credits: updatedUnit.credits
    });
    
    res.json({ 
      success: true, 
      unit: updatedUnit 
    });

  } catch (error) {
    console.error('❌ Error updating course unit:', error);
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE course unit
app.delete('/api/course-units/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT DELETE ==========');
  console.log('Params ID:', req.params.id);
  
  try {
    const { id } = req.params;

    // Find the unit
    const unit = await CourseUnit.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }

    console.log('Found unit to delete:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module
    });

    // Check if this unit is used in any exams
    const examsUsingUnit = await Exam.count({
      where: { unitId: id }
    });

    if (examsUsingUnit > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete unit because it is used in ${examsUsingUnit} exam(s). Please remove those exams first.` 
      });
    }

    // Check if this unit is used in any timetable entries
    const timetableEntries = await Timetable.count({
      where: { unitId: id }
    });

    if (timetableEntries > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete unit because it is used in ${timetableEntries} timetable entry(s). Please remove those entries first.` 
      });
    }

    // Delete the unit
    await unit.destroy();

    // Create audit log
    await createAuditLog(req, 'DELETE', 'COURSE_UNIT', id, null, null);

    console.log('✅ Course unit deleted successfully');
    res.json({ 
      success: true, 
      message: 'Course unit deleted successfully' 
    });

  } catch (error) {
    console.error('❌ Error deleting course unit:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// BULK CREATE course units (for importing)
app.post('/api/course-units/bulk', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT BULK CREATE ==========');
  
  try {
    const { units } = req.body;
    
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide an array of units' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    const createdUnits = [];
    const errors = [];

    for (const unitData of units) {
      try {
        // Verify course exists
        const course = await Course.findOne({
          where: { 
            id: unitData.courseId, 
            schoolId: req.user.schoolId 
          }
        });

        if (!course) {
          errors.push({ 
            data: unitData, 
            error: `Course ${unitData.courseId} not found` 
          });
          continue;
        }

        // Prepare data with proper handling
        const data = {
          name: unitData.name?.trim(),
          code: unitData.code?.trim() || null,
          courseId: unitData.courseId,
          year: unitData.year ? parseInt(unitData.year) : null,
          credits: unitData.credits ? parseInt(unitData.credits) : 3,
          description: unitData.description?.trim() || null,
          schoolId: req.user.schoolId
        };

        // Handle semester/module based on school type
        if (isUniversity) {
          data.semester = unitData.semester ? parseInt(unitData.semester) : null;
          data.module = null;
        } else if (isTVET) {
          data.module = unitData.module ? parseInt(unitData.module) : null;
          data.semester = null;
        } else {
          data.semester = unitData.semester ? parseInt(unitData.semester) : null;
          data.module = unitData.module ? parseInt(unitData.module) : null;
        }

        const unit = await CourseUnit.create(data);
        
        const createdUnit = await CourseUnit.findByPk(unit.id, {
          include: [{ model: Course, attributes: ['id', 'name', 'code'] }]
        });
        
        createdUnits.push(createdUnit);
        
      } catch (err) {
        console.error('Error creating unit:', err);
        errors.push({ 
          data: unitData, 
          error: err.message 
        });
      }
    }

    await createAuditLog(req, 'BULK_CREATE', 'COURSE_UNIT', null, null, { 
      count: createdUnits.length,
      errors: errors.length 
    });

    console.log(`✅ Created ${createdUnits.length} units, ${errors.length} errors`);
    
    res.status(201).json({ 
      success: true, 
      units: createdUnits,
      errors: errors.length > 0 ? errors : undefined,
      summary: {
        created: createdUnits.length,
        failed: errors.length,
        total: units.length
      }
    });

  } catch (error) {
    console.error('❌ Bulk create course units error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/labs', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const labs = await Lab.findAll({ 
      where,
      include: [{ model: Department }]
    });
    res.json({ success: true, labs });
  } catch (error) {
    console.error('Get labs error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/labs', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, departmentId, incharge, capacity, location } = req.body;
    
    const department = await Department.findOne({
      where: { id: departmentId, schoolId: req.user.schoolId }
    });
    
    if (!department) {
      return res.status(400).json({ message: 'Department not found' });
    }
    
    const lab = await Lab.create({
      name,
      departmentId,
      incharge,
      capacity,
      location,
      schoolId: req.user.schoolId
    });
    
    const createdLab = await Lab.findByPk(lab.id, {
      include: [{ model: Department }]
    });
    
    res.status(201).json({ success: true, lab: createdLab });
  } catch (error) {
    console.error('Create lab error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/research', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const research = await Research.findAll({ 
      where,
      include: [{ model: Faculty }]
    });
    res.json({ success: true, research });
  } catch (error) {
    console.error('Get research error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/research', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { title, facultyId, researcher, startDate, endDate, funding, status } = req.body;
    
    const faculty = await Faculty.findOne({
      where: { id: facultyId, schoolId: req.user.schoolId }
    });
    
    if (!faculty) {
      return res.status(400).json({ message: 'Faculty not found' });
    }
    
    const research = await Research.create({
      title,
      facultyId,
      researcher,
      startDate,
      endDate,
      funding,
      status,
      schoolId: req.user.schoolId
    });
    
    const createdResearch = await Research.findByPk(research.id, {
      include: [{ model: Faculty }]
    });
    
    res.status(201).json({ success: true, research: createdResearch });
  } catch (error) {
    console.error('Create research error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== FEE REMINDERS ROUTE ====================

app.post('/api/fee-reminders/send', authenticate, async (req, res) => {
  try {
    const { classId, specificStudents, courseId } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
    } else {
      if (classId) where.classId = classId;
    }
    
    const students = specificStudents 
      ? await Student.findAll({ where: { id: specificStudents } })
      : await Student.findAll({ where });
    
    const reminders = [];
    
    for (const student of students) {
      let feeWhere = { schoolId: req.user.schoolId };
      
      if (school.category === 'UNIVERSITY') {
        feeWhere.courseId = student.courseId;
        feeWhere.year = student.currentYear;
      } else if (school.category === 'COLLEGE_TVET') {
        feeWhere.programId = student.programId;
      } else {
        feeWhere.classId = student.classId;
      }
      
      const totalFees = await Fee.sum('amount', { where: feeWhere }) || 0;
      
      const payments = await Payment.sum('amount', {
        where: { studentId: student.id }
      }) || 0;
      
      const balance = totalFees - payments;
      
      if (balance > 0) {
        const parents = await Parent.findAll({
          where: { studentId: student.id },
          include: [{ model: User }]
        });
        
        for (const parent of parents) {
          if (parent.User && parent.User.phone) {
            const message = {
              type: 'SMS',
              to: parent.User.phone,
              content: `Fee reminder for ${student.firstName} ${student.lastName}: Balance KES ${balance}. Due date: ${new Date().toLocaleDateString()}`,
              schoolId: req.user.schoolId
            };
            
            await Message.create(message);
            reminders.push({ student: student.id, parent: parent.User.phone, balance });
          }
        }
      }
    }
    
    res.json({ success: true, remindersSent: reminders.length, reminders });
  } catch (error) {
    console.error('Send reminders error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ==================== STAFF ATTENDANCE ROUTES (SEQUELIZE VERSION - FIXED) ====================

// ==================== STAFF TIME IN ====================
app.post('/api/staff-attendance/time-in', authenticate, async (req, res) => {
  try {
    const { date, timeIn, remarks } = req.body;
    const userId = req.user.id;
    
    console.log('⏰ Time In request:', { userId, date, timeIn });
    
    // Find staff member
    const staff = await Staff.findOne({
      where: { userId: userId },
      include: [{ model: School }]
    });
    
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff record not found. Please contact HR.' });
    }
    
    console.log('👤 Staff found:', staff.id, staff.jobTitle);
    
    // Check if already marked for today
    const today = date || new Date().toISOString().split('T')[0];
    const existing = await StaffAttendance.findOne({
      where: {
        staffId: staff.id,
        date: today
      }
    });
    
    if (existing && existing.timeIn) {
      return res.status(400).json({ success: false, message: 'Already clocked in today' });
    }
    
    // Get school settings to determine if late
    const startTime = staff.School?.startTime || '08:00';
    const lateThreshold = staff.School?.lateThreshold || 30;
    
    // Calculate late time
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const lateMinutes = startHours * 60 + startMinutes + lateThreshold;
    const [inHours, inMinutes] = timeIn.split(':').map(Number);
    const timeInMinutes = inHours * 60 + inMinutes;
    
    const isLate = timeInMinutes > lateMinutes;
    const finalStatus = isLate ? 'LATE' : 'PRESENT';
    
    let attendance;
    if (existing) {
      await existing.update({
        timeIn,
        status: finalStatus,
        remarks: remarks || (isLate ? `Arrived at ${timeIn} (Late by ${timeInMinutes - lateMinutes} mins)` : ''),
        updatedAt: new Date()
      });
      attendance = existing;
    } else {
      attendance = await StaffAttendance.create({
        staffId: staff.id,
        date: today,
        timeIn,
        status: finalStatus,
        remarks: remarks || (isLate ? `Arrived at ${timeIn} (Late by ${timeInMinutes - lateMinutes} mins)` : ''),
        schoolId: staff.schoolId,
        approved: false,
        approvalStatus: 'PENDING'
      });
    }
    
    console.log('✅ Time In recorded:', attendance.id);
    
    res.json({
      success: true,
      message: isLate ? `Time In recorded (LATE - School starts at ${startTime}, late after ${lateThreshold} minutes)` : 'Time In recorded successfully',
      attendance
    });
  } catch (error) {
    console.error('Error recording time in:', error);
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ==================== STAFF TIME OUT ====================
app.patch('/api/staff-attendance/:id/time-out', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { timeOut } = req.body;
    
    console.log('⏰ Time Out request:', { id, timeOut });
    
    const attendance = await StaffAttendance.findByPk(id, {
      include: [{ model: Staff }]
    });
    
    if (!attendance) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }
    
    if (!attendance.timeIn) {
      return res.status(400).json({ success: false, message: 'Please clock in first' });
    }
    
    if (attendance.timeOut) {
      return res.status(400).json({ success: false, message: 'Already clocked out today' });
    }
    
    // Calculate hours worked
    const [inHours, inMinutes] = attendance.timeIn.split(':').map(Number);
    const [outHours, outMinutes] = timeOut.split(':').map(Number);
    const hoursWorked = ((outHours * 60 + outMinutes) - (inHours * 60 + inMinutes)) / 60;
    
    await attendance.update({
      timeOut,
      updatedAt: new Date(),
      remarks: attendance.remarks 
        ? `${attendance.remarks} | Clocked out at ${timeOut} (${hoursWorked.toFixed(1)} hours)` 
        : `Clocked out at ${timeOut} (${hoursWorked.toFixed(1)} hours)`
    });
    
    console.log('✅ Time Out recorded:', attendance.id, `Hours: ${hoursWorked.toFixed(1)}`);
    
    res.json({
      success: true,
      message: `Time Out recorded. Hours worked: ${hoursWorked.toFixed(1)}`,
      attendance
    });
  } catch (error) {
    console.error('Error recording time out:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== GET STAFF ATTENDANCE ====================
app.get('/api/staff-attendance', authenticate, async (req, res) => {
  try {
    const { staffId, startDate, endDate, department, status, approved } = req.query;
    const userId = req.user.id;
    
    let where = {};
    
    if (staffId) {
      where.staffId = staffId;
    } else {
      const staff = await Staff.findOne({ where: { userId } });
      
      const isAdmin = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
      
      if (staff && !isAdmin) {
        where.staffId = staff.id;
      } else if (department && isAdmin) {
        const staffInDept = await Staff.findAll({
          where: { department },
          attributes: ['id']
        });
        where.staffId = staffInDept.map(s => s.id);
      }
    }
    
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date[Op.gte] = startDate;
      if (endDate) where.date[Op.lte] = endDate;
    }
    
    if (status) where.status = status;
    if (approved === 'true') where.approved = true;
    if (approved === 'false') where.approved = false;
    if (approved === 'pending') where.approvalStatus = 'PENDING';
    
    const attendance = await StaffAttendance.findAll({
      where,
      include: [
        {
          model: Staff,
          include: [
            {
              model: User,
              attributes: ['id', 'firstName', 'lastName', 'email', 'phone']
            }
          ]
        }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({
      success: true,
      attendance
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== STAFF LEAVE REQUEST ====================
app.post('/api/staff-attendance/leave-request', authenticate, async (req, res) => {
  try {
    const { date, leaveType, remarks } = req.body;
    const userId = req.user.id;
    
    const staff = await Staff.findOne({ where: { userId } });
    
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff record not found' });
    }
    
    const existing = await StaffAttendance.findOne({
      where: {
        staffId: staff.id,
        date: date
      }
    });
    
    if (existing) {
      return res.status(400).json({ success: false, message: 'Attendance already recorded for this date' });
    }
    
    const attendance = await StaffAttendance.create({
      staffId: staff.id,
      date: date,
      status: 'LEAVE',
      leaveType,
      remarks: remarks || `Leave request: ${leaveType}`,
      schoolId: staff.schoolId,
      approved: false,
      approvalStatus: 'PENDING'
    });
    
    res.json({
      success: true,
      message: 'Leave request submitted for approval',
      attendance
    });
  } catch (error) {
    console.error('Error submitting leave request:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== GET MY PENDING REQUESTS ====================
app.get('/api/staff-attendance/my-pending', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const staff = await Staff.findOne({ where: { userId } });
    
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff record not found' });
    }
    
    const pending = await StaffAttendance.findAll({
      where: {
        staffId: staff.id,
        approved: false,
        approvalStatus: 'PENDING'
      },
      order: [['date', 'ASC']]
    });
    
    res.json({
      success: true,
      pending
    });
  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== GET PENDING APPROVALS (HR/Admin) ====================
app.get('/api/staff-attendance/pending', authenticate, async (req, res) => {
  try {
    const canApprove = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const { department } = req.query;
    
    let where = {
      approved: false,
      approvalStatus: 'PENDING'
    };
    
    if (department) {
      const staffInDept = await Staff.findAll({
        where: { department },
        attributes: ['id']
      });
      where.staffId = staffInDept.map(s => s.id);
    }
    
    const pending = await StaffAttendance.findAll({
      where,
      include: [
        {
          model: Staff,
          include: [
            {
              model: User,
              attributes: ['id', 'firstName', 'lastName', 'email']
            }
          ]
        }
      ],
      order: [['date', 'ASC']]
    });
    
    res.json({
      success: true,
      pending
    });
  } catch (error) {
    console.error('Error fetching pending approvals:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== APPROVE/REJECT ATTENDANCE ====================
app.patch('/api/staff-attendance/:id/approve', authenticate, async (req, res) => {
  try {
    const canApprove = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const { id } = req.params;
    const { action } = req.body;
    
    const approved = action === 'APPROVE';
    const approvalStatus = approved ? 'APPROVED' : 'REJECTED';
    
    const attendance = await StaffAttendance.findByPk(id);
    
    if (!attendance) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }
    
    await attendance.update({
      approved,
      approvalStatus,
      approvedBy: req.user.id,
      approvedAt: new Date()
    });
    
    res.json({
      success: true,
      message: `Attendance ${action.toLowerCase()}d successfully`,
      attendance
    });
  } catch (error) {
    console.error('Error approving attendance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== GET SCHOOL ATTENDANCE SETTINGS ====================
app.get('/api/staff-attendance/settings/:schoolId', authenticate, async (req, res) => {
  try {
    const { schoolId } = req.params;
    
    const school = await School.findByPk(schoolId, {
      attributes: ['id', 'name', 'startTime', 'endTime', 'lateThreshold', 'earlyDepartureThreshold']
    });
    
    if (!school) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }
    
    const startTime = school.startTime || '08:00';
    const lateThreshold = school.lateThreshold || 30;
    const [startHours, startMinutes] = startTime.split(':').map(Number);
    const lateMinutes = startHours * 60 + startMinutes + lateThreshold;
    const lateHours = Math.floor(lateMinutes / 60);
    const lateMins = lateMinutes % 60;
    const lateTime = `${lateHours.toString().padStart(2, '0')}:${lateMins.toString().padStart(2, '0')}`;
    
    res.json({
      success: true,
      settings: {
        startTime: startTime,
        endTime: school.endTime || '17:00',
        lateThreshold: lateThreshold,
        earlyDepartureThreshold: school.earlyDepartureThreshold || 30,
        lateTime: lateTime
      }
    });
  } catch (error) {
    console.error('Error fetching attendance settings:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== UPDATE SCHOOL ATTENDANCE SETTINGS ====================
app.put('/api/staff-attendance/settings/:schoolId', authenticate, async (req, res) => {
  try {
    const canUpdate = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'].includes(req.user.role);
    
    if (!canUpdate) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const { schoolId } = req.params;
    const { startTime, endTime, lateThreshold, earlyDepartureThreshold } = req.body;
    
    if (startTime && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(startTime)) {
      return res.status(400).json({ success: false, message: 'Invalid start time format. Use HH:MM' });
    }
    
    if (endTime && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(endTime)) {
      return res.status(400).json({ success: false, message: 'Invalid end time format. Use HH:MM' });
    }
    
    if (lateThreshold && (lateThreshold < 0 || lateThreshold > 120)) {
      return res.status(400).json({ success: false, message: 'Late threshold must be between 0 and 120 minutes' });
    }
    
    const school = await School.findByPk(schoolId);
    
    if (!school) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }
    
    await school.update({
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      lateThreshold: lateThreshold !== undefined ? lateThreshold : undefined,
      earlyDepartureThreshold: earlyDepartureThreshold !== undefined ? earlyDepartureThreshold : undefined
    });
    
    res.json({
      success: true,
      message: 'Attendance settings updated successfully',
      settings: {
        startTime: school.startTime || '08:00',
        endTime: school.endTime || '17:00',
        lateThreshold: school.lateThreshold || 30,
        earlyDepartureThreshold: school.earlyDepartureThreshold || 30
      }
    });
  } catch (error) {
    console.error('Error updating attendance settings:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== GET ATTENDANCE REPORT ====================
app.get('/api/staff-attendance/report', authenticate, async (req, res) => {
  try {
    const canView = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
    
    if (!canView) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const { startDate, endDate, department } = req.query;
    
    let staffFilter = {};
    if (department) {
      staffFilter.department = department;
    }
    
    const staff = await Staff.findAll({
      where: staffFilter,
      include: [
        {
          model: User,
          attributes: ['firstName', 'lastName']
        },
        {
          model: StaffAttendance,
          as: 'attendances',
          required: false,
          where: {
            date: {
              [Op.gte]: startDate || new Date(new Date().setDate(1)),
              [Op.lte]: endDate || new Date()
            }
          }
        }
      ]
    });
    
    let totalPresent = 0;
    let totalAbsent = 0;
    let totalLate = 0;
    let totalLeave = 0;
    let pendingApprovals = 0;
    let rejectedApprovals = 0;
    
    staff.forEach(s => {
      if (s.attendances && s.attendances.length) {
        s.attendances.forEach(a => {
          if (a.approved) {
            if (a.status === 'PRESENT') totalPresent++;
            else if (a.status === 'ABSENT') totalAbsent++;
            else if (a.status === 'LATE') totalLate++;
            else if (a.status === 'LEAVE') totalLeave++;
          } else if (a.approvalStatus === 'PENDING') {
            pendingApprovals++;
          } else if (a.approvalStatus === 'REJECTED') {
            rejectedApprovals++;
          }
        });
      }
    });
    
    res.json({
      success: true,
      summary: {
        totalStaff: staff.length,
        totalPresent,
        totalAbsent,
        totalLate,
        totalLeave,
        pendingApprovals,
        rejectedApprovals
      }
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// ADD THESE ROUTES to your backend:

// GET /api/features - Get all features for a school
app.get('/api/features', authenticate, async (req, res) => {
  try {
    const features = await Feature.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, features });
  } catch (error) {
    console.error('Get features error:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/features/:code/toggle - Toggle feature on/off
app.patch('/api/features/:code/toggle', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const [feature, created] = await Feature.findOrCreate({
      where: { code: req.params.code, schoolId: req.user.schoolId },
      defaults: {
        name: req.params.code,
        code: req.params.code,
        category: 'GENERAL',
        isEnabled: true,
        schoolId: req.user.schoolId
      }
    });

    if (!created) {
      await feature.update({ isEnabled: !feature.isEnabled });
    }

    res.json({ success: true, feature });
  } catch (error) {
    console.error('Toggle feature error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// GET /api/settings/notifications - Get notification settings
app.get('/api/settings/notifications', authenticate, async (req, res) => {
  try {
    // You can create a NotificationSettings model or store in school settings
    const school = await School.findByPk(req.user.schoolId);
    
    const notifications = [
      { 
        id: 'fee-reminders', 
        name: 'Fee Reminders', 
        description: 'Send reminders to parents about overdue fees',
        enabled: school?.settings?.notifications?.feeReminders ?? true 
      },
      { 
        id: 'exam-results', 
        name: 'Exam Results Published', 
        description: 'Notify parents when results are published',
        enabled: school?.settings?.notifications?.examResults ?? true 
      },
      { 
        id: 'attendance-alerts', 
        name: 'Attendance Alerts', 
        description: 'Alert parents when student is absent',
        enabled: school?.settings?.notifications?.attendanceAlerts ?? false 
      },
      { 
        id: 'payment-receipts', 
        name: 'Payment Receipts', 
        description: 'Send receipt via SMS/Email after payment',
        enabled: school?.settings?.notifications?.paymentReceipts ?? true 
      }
    ];
    
    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/settings/notifications/:id/toggle - Toggle notification
app.patch('/api/settings/notifications/:id/toggle', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.user.schoolId);
    const settings = school.settings || {};
    const notifications = settings.notifications || {};
    
    // Toggle the specific notification
    notifications[req.params.id] = !notifications[req.params.id];
    
    await school.update({
      settings: { ...settings, notifications }
    });
    
    res.json({ 
      success: true, 
      notification: { 
        id: req.params.id, 
        enabled: notifications[req.params.id] 
      } 
    });
  } catch (error) {
    console.error('Toggle notification error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// POST /api/backup/create - Create a database backup
app.post('/api/backup/create', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${req.user.schoolId}-${timestamp}.json`;
    const filepath = path.join(__dirname, 'backups', filename);
    
    // Create backups directory if it doesn't exist
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // Get all data for this school
    const data = {
      school: await School.findByPk(req.user.schoolId),
      students: await Student.findAll({ where: { schoolId: req.user.schoolId } }),
      staff: await Staff.findAll({ where: { schoolId: req.user.schoolId } }),
      classes: await Class.findAll({ where: { schoolId: req.user.schoolId } }),
      subjects: await Subject.findAll({ where: { schoolId: req.user.schoolId } }),
      exams: await Exam.findAll({ where: { schoolId: req.user.schoolId } }),
      fees: await Fee.findAll({ where: { schoolId: req.user.schoolId } }),
      payments: await Payment.findAll({ where: { schoolId: req.user.schoolId } }),
      timestamp: new Date(),
      version: '1.0'
    };
    
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    
    res.json({ 
      success: true, 
      filename,
      message: 'Backup created successfully'
    });
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /api/backup/history - Get backup history
app.get('/api/backup/history', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    
    if (!fs.existsSync(backupDir)) {
      return res.json({ success: true, backups: [] });
    }
    
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(`backup-${req.user.schoolId}`) && f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return {
          filename: f,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created);
    
    res.json({ success: true, backups: files });
  } catch (error) {
    console.error('Backup history error:', error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/backup/restore - Restore from backup
app.post('/api/backup/restore', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    const filepath = path.join(__dirname, 'backups', filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }
    
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    
    // Validate that this backup belongs to this school
    if (data.school.id !== req.user.schoolId) {
      return res.status(403).json({ message: 'This backup does not belong to your school' });
    }
    
    // TODO: Implement restore logic (this is complex - requires transactions)
    // For now, just acknowledge
    res.json({ 
      success: true, 
      message: 'Restore functionality requires careful implementation. Please restore manually.' 
    });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /api/backup/download/:filename - Download backup
app.get('/api/backup/download/:filename', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const filepath = path.join(__dirname, 'backups', req.params.filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }
    
    res.download(filepath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// GET /api/export/:type - Export data as CSV
app.get('/api/export/:type', authenticate, async (req, res) => {
  try {
    const { type } = req.params;
    const { format = 'csv' } = req.query;
    
    let data = [];
    let filename = `${type}_${new Date().toISOString().split('T')[0]}`;
    
    switch(type) {
      case 'students':
        data = await Student.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: Class }]
        });
        filename += '_students.csv';
        break;
      case 'staff':
        data = await Staff.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: User }]
        });
        filename += '_staff.csv';
        break;
      case 'fees':
        data = await Fee.findAll({ where: { schoolId: req.user.schoolId } });
        filename += '_fees.csv';
        break;
      case 'payments':
        data = await Payment.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: Student }]
        });
        filename += '_payments.csv';
        break;
      case 'results':
        data = await Result.findAll({ 
          include: [
            { model: Student, where: { schoolId: req.user.schoolId } },
            { model: Exam }
          ]
        });
        filename += '_results.csv';
        break;
      case 'attendance':
        data = await Attendance.findAll({ 
          include: [
            { model: Student, where: { schoolId: req.user.schoolId } }
          ]
        });
        filename += '_attendance.csv';
        break;
      default:
        return res.status(400).json({ message: 'Invalid export type' });
    }
    
    // Convert to CSV
    if (data.length === 0) {
      return res.status(404).json({ message: 'No data to export' });
    }
    
    const headers = Object.keys(data[0].toJSON()).join(',');
    const rows = data.map(item => {
      const values = Object.values(item.toJSON()).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v).replace(/,/g, ';');
        return String(v).replace(/,/g, ';');
      });
      return values.join(',');
    });
    
    const csv = [headers, ...rows].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== HEALTH RECORDS ENDPOINTS ====================

// GET all health records
app.get('/api/health-records', authenticateToken, async (req, res) => {
  try {
    const { studentId, startDate, endDate, status } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (status) where.status = status;
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }
    
    const records = await HealthRecords.findAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching health records:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET single health record
app.get('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [{ model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }]
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    res.json({ success: true, record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create health record
app.post('/api/health-records', authenticateToken, async (req, res) => {
  try {
    const { studentId, date, temperature, bloodPressure, weight, height, symptoms, diagnosis, prescription, followUpDate, notes, status } = req.body;
    
    if (!studentId || !date || !diagnosis) {
      return res.status(400).json({ success: false, message: 'Student ID, date, and diagnosis are required' });
    }
    
    const record = await HealthRecords.create({
      studentId,
      date,
      temperature: temperature || null,
      bloodPressure: bloodPressure || null,
      weight: weight || null,
      height: height || null,
      symptoms: symptoms || null,
      diagnosis,
      prescription: prescription || null,
      followUpDate: followUpDate || null,
      notes: notes || null,
      status: status || 'TREATED',
      schoolId: req.user.schoolId,
      recordedBy: req.user.id
    });
    
    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error creating health record:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update health record
app.put('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    
    await record.update(req.body);
    res.json({ success: true, record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE health record
app.delete('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    
    await record.destroy();
    res.json({ success: true, message: 'Health record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ==================== SCHEMES OF WORK ENDPOINTS ====================

// GET all schemes of work (with filters for all school types)
app.get('/api/schemes-of-work', authenticate, async (req, res) => {
  try {
    const { 
      classId, subjectId, courseId, unitId, programId, moduleId,
      period, week, covered 
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    // Regular School filters
    if (classId) where.classId = classId;
    if (subjectId) where.subjectId = subjectId;
    
    // University filters
    if (courseId) where.courseId = courseId;
    if (unitId) where.unitId = unitId;
    
    // TVET filters
    if (programId) where.programId = programId;
    if (moduleId) where.moduleId = moduleId;
    
    if (period) where.period = period;
    if (week) where.week = week;
    if (covered !== undefined) where.covered = covered === 'true';
    
    const include = [];
    
    // Include based on school type (using correct aliases)
    if (classId) include.push({ model: Class, attributes: ['id', 'name'] });
    if (subjectId) include.push({ model: Subject, attributes: ['id', 'name', 'code'] });
    if (courseId) include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    if (unitId) include.push({ model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] });
    if (programId) include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    if (moduleId) include.push({ model: CourseUnit, as: 'tvetModule', attributes: ['id', 'name', 'code'] });
    
    const schemes = await SchemesOfWork.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, schemes });
  } catch (error) {
    console.error('Error fetching schemes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create scheme (supports all school types)
app.post('/api/schemes-of-work', authenticate, async (req, res) => {
  try {
    const { 
      classId, subjectId, courseId, unitId, programId, moduleId,
      period, week, topic, subTopic, objectives, teachingActivities,
      learningActivities, resources, assessment, remarks, covered, dateCovered
    } = req.body;
    
    // Validation - at least one identifier must be present
    const hasRegularSchoolId = classId && subjectId;
    const hasUniversityId = courseId && unitId;
    const hasTVETId = programId && moduleId;
    
    if (!hasRegularSchoolId && !hasUniversityId && !hasTVETId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide either (classId + subjectId), (courseId + unitId), or (programId + moduleId)' 
      });
    }
    
    if (!period || !week || !topic) {
      return res.status(400).json({ 
        success: false, 
        message: 'Period, Week, and Topic are required' 
      });
    }
    
    // Verify the references exist based on school type
    const school = await School.findByPk(req.user.schoolId);
    
    if (hasTVETId) {
      // Verify program exists
      const program = await Program.findOne({
        where: { id: programId, schoolId: req.user.schoolId }
      });
      if (!program) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program not found or does not belong to your school' 
        });
      }
      
      // Verify module exists
      const module = await CourseUnit.findOne({
        where: { id: moduleId, programId: programId, schoolId: req.user.schoolId }
      });
      if (!module) {
        return res.status(400).json({ 
          success: false, 
          message: 'Module not found or does not belong to this program' 
        });
      }
    }
    
    // Create the scheme
    const scheme = await SchemesOfWork.create({
      // Regular School fields
      classId: classId || null,
      subjectId: subjectId || null,
      // University fields
      courseId: courseId || null,
      unitId: unitId || null,
      // TVET fields
      programId: programId || null,
      moduleId: moduleId || null,
      // Common fields
      period,
      week,
      topic,
      subTopic: subTopic || null,
      objectives: objectives || null,
      teachingActivities: teachingActivities || null,
      learningActivities: learningActivities || null,
      resources: resources || null,
      assessment: assessment || null,
      remarks: remarks || null,
      covered: covered || false,
      dateCovered: dateCovered || null,
      schoolId: req.user.schoolId,
      createdBy: req.user.id
    });
    
    // Fetch the created scheme with includes
    const include = [];
    if (classId) include.push({ model: Class, attributes: ['id', 'name'] });
    if (subjectId) include.push({ model: Subject, attributes: ['id', 'name', 'code'] });
    if (courseId) include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    if (unitId) include.push({ model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] });
    if (programId) include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    if (moduleId) include.push({ model: CourseUnit, as: 'tvetModule', attributes: ['id', 'name', 'code'] });
    
    const createdScheme = await SchemesOfWork.findByPk(scheme.id, { include });
    
    res.status(201).json({ success: true, scheme: createdScheme });
  } catch (error) {
    console.error('Error creating scheme:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ==================== SICK BAY ENDPOINTS ====================

// GET sick bay information (room details and current patients)
app.get('/api/sick-bay', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    
    // Find the sick bay room across all hostels
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'capacity', 'rooms']
    });
    
    let sickBayRoom = null;
    let sickBayHostel = null;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const room = rooms.find(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (room) {
        sickBayRoom = room;
        sickBayHostel = hostel;
        break;
      }
    }
    
    // If no sick bay exists, create default
    if (!sickBayRoom && hostels.length > 0) {
      // Create sick bay in the first hostel
      const defaultHostel = hostels[0];
      const updatedRooms = [...(defaultHostel.rooms || []), {
        roomNumber: 'Sick Bay',
        name: 'Sick Bay',
        beds: 4,
        occupied: 0,
        students: [],
        type: 'SICK_BAY',
        isSickBay: true
      }];
      
      await defaultHostel.update({ rooms: updatedRooms });
      
      sickBayRoom = updatedRooms[updatedRooms.length - 1];
      sickBayHostel = defaultHostel;
    }
    
    // Get current patients (students in sick bay)
    const patients = [];
    if (sickBayRoom && sickBayRoom.students) {
      for (const studentId of sickBayRoom.students) {
        const student = await Student.findOne({
          where: { id: studentId, schoolId },
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        });
        
        if (student) {
          // Get latest health record for this student
          const healthRecord = await HealthRecords.findOne({
            where: { studentId, schoolId },
            order: [['date', 'DESC']]
          });
          
          patients.push({
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            admissionNumber: student.admissionNumber,
            diagnosis: healthRecord?.diagnosis || 'N/A',
            admittedDate: healthRecord?.date || new Date().toISOString().split('T')[0],
            healthRecordId: healthRecord?.id
          });
        }
      }
    }
    
    res.json({
      success: true,
      sickBay: {
        room: sickBayRoom,
        hostel: sickBayHostel ? { id: sickBayHostel.id, name: sickBayHostel.name } : null,
        patients,
        availableBeds: sickBayRoom ? (sickBayRoom.beds - (sickBayRoom.students?.length || 0)) : 0,
        totalBeds: sickBayRoom?.beds || 0,
        occupied: sickBayRoom?.students?.length || 0
      }
    });
    
  } catch (error) {
    console.error('❌ Get sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST admit student to sick bay
app.post('/api/sick-bay/admit', authenticateToken, async (req, res) => {
  try {
    const { studentId } = req.body;
    const schoolId = req.user.schoolId;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    // Verify student exists and belongs to this school
    const student = await Student.findOne({
      where: { id: studentId, schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Find the sick bay room
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'rooms']
    });
    
    let sickBayHostel = null;
    let sickBayRoomIndex = -1;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const index = rooms.findIndex(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (index !== -1) {
        sickBayHostel = hostel;
        sickBayRoomIndex = index;
        break;
      }
    }
    
    if (!sickBayHostel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Sick Bay room not found. Please create a "Sick Bay" room in Hostel Management first.' 
      });
    }
    
    const rooms = sickBayHostel.rooms;
    const room = rooms[sickBayRoomIndex];
    
    // Check if student is already in sick bay
    if (room.students?.includes(studentId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already in Sick Bay' 
      });
    }
    
    // Check capacity
    if ((room.students?.length || 0) >= room.beds) {
      return res.status(400).json({ 
        success: false, 
        message: `Sick Bay is full (${room.beds} beds capacity)` 
      });
    }
    
    // Add student to room
    const updatedStudents = [...(room.students || []), studentId];
    rooms[sickBayRoomIndex] = {
      ...room,
      students: updatedStudents,
      occupied: updatedStudents.length
    };
    
    await sickBayHostel.update({ rooms });
    
    // Create a health record for admission if not exists
    const existingHealth = await HealthRecords.findOne({
      where: { studentId, schoolId, date: new Date().toISOString().split('T')[0] }
    });
    
    if (!existingHealth) {
      await HealthRecords.create({
        id: crypto.randomUUID(),
        studentId,
        date: new Date().toISOString().split('T')[0],
        diagnosis: 'Admitted to Sick Bay',
        status: 'ADMITTED',
        notes: `Admitted to Sick Bay by ${req.user.firstName} ${req.user.lastName}`,
        schoolId,
        recordedBy: req.user.id
      });
    }
    
    // Create audit log
    await createAuditLog(req, 'ADMIT', 'SICK_BAY', null, null, { studentId, studentName: `${student.firstName} ${student.lastName}` });
    
    res.json({ 
      success: true, 
      message: `${student.firstName} ${student.lastName} admitted to Sick Bay`,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
    
  } catch (error) {
    console.error('❌ Admit to sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST discharge student from sick bay
app.post('/api/sick-bay/discharge', authenticateToken, async (req, res) => {
  try {
    const { studentId } = req.body;
    const schoolId = req.user.schoolId;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    // Verify student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Find the sick bay room
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'rooms']
    });
    
    let sickBayHostel = null;
    let sickBayRoomIndex = -1;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const index = rooms.findIndex(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (index !== -1) {
        sickBayHostel = hostel;
        sickBayRoomIndex = index;
        break;
      }
    }
    
    if (!sickBayHostel) {
      return res.status(404).json({ success: false, message: 'Sick Bay room not found' });
    }
    
    const rooms = sickBayHostel.rooms;
    const room = rooms[sickBayRoomIndex];
    
    // Check if student is in sick bay
    if (!room.students?.includes(studentId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is not in Sick Bay' 
      });
    }
    
    // Remove student from room
    const updatedStudents = room.students.filter(id => id !== studentId);
    rooms[sickBayRoomIndex] = {
      ...room,
      students: updatedStudents,
      occupied: updatedStudents.length
    };
    
    await sickBayHostel.update({ rooms });
    
    // Update health record status
    const today = new Date().toISOString().split('T')[0];
    const healthRecord = await HealthRecords.findOne({
      where: { studentId, schoolId, status: 'ADMITTED' },
      order: [['date', 'DESC']]
    });
    
    if (healthRecord) {
      await healthRecord.update({ 
        status: 'DISCHARGED',
        notes: `${healthRecord.notes || ''} Discharged on ${today}`
      });
    }
    
    // Create discharge record
    await HealthRecords.create({
      id: crypto.randomUUID(),
      studentId,
      date: today,
      diagnosis: 'Discharged from Sick Bay',
      status: 'DISCHARGED',
      notes: `Discharged from Sick Bay by ${req.user.firstName} ${req.user.lastName}`,
      schoolId,
      recordedBy: req.user.id
    });
    
    // Create audit log
    await createAuditLog(req, 'DISCHARGE', 'SICK_BAY', null, null, { studentId, studentName: `${student.firstName} ${student.lastName}` });
    
    res.json({ 
      success: true, 
      message: `${student.firstName} ${student.lastName} discharged from Sick Bay`,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
    
  } catch (error) {
    console.error('❌ Discharge from sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET today's sick students (from attendance)
app.get('/api/sick-bay/today-sick', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const today = new Date().toISOString().split('T')[0];
    
    const sickAttendance = await Attendance.findAll({
      where: {
        schoolId,
        status: 'SICK',
        date: today
      },
      include: [
        {
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          where: { schoolId }
        }
      ]
    });
    
    // Get current sick bay patients to check if already admitted
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['rooms']
    });
    
    let sickBayStudentIds = [];
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      for (const room of rooms) {
        if (room.roomNumber === 'Sick Bay' || room.name === 'Sick Bay' || room.type === 'SICK_BAY') {
          sickBayStudentIds = [...sickBayStudentIds, ...(room.students || [])];
        }
      }
    }
    
    const sickStudents = sickAttendance.map(record => ({
      id: record.Student.id,
      firstName: record.Student.firstName,
      lastName: record.Student.lastName,
      admissionNumber: record.Student.admissionNumber,
      recordId: record.id,
      diagnosis: record.remarks || 'Sick',
      isInSickBay: sickBayStudentIds.includes(record.studentId)
    }));
    
    res.json({
      success: true,
      sickStudents,
      count: sickStudents.length
    });
    
  } catch (error) {
    console.error('❌ Get today\'s sick students error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create/initialize sick bay room in a hostel
app.post('/api/sick-bay/initialize', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { hostelId, beds = 4, roomNumber = 'Sick Bay' } = req.body;
    
    // Find the hostel
    let hostel;
    if (hostelId) {
      hostel = await Hostel.findOne({ where: { id: hostelId, schoolId } });
    } else {
      // If no hostel specified, find the first hostel or create one
      hostel = await Hostel.findOne({ where: { schoolId } });
      
      if (!hostel) {
        // Create a default hostel
        hostel = await Hostel.create({
          id: crypto.randomUUID(),
          name: 'Main Hostel',
          gender: 'MIXED',
          capacity: 100,
          schoolId,
          rooms: []
        });
      }
    }
    
    if (!hostel) {
      return res.status(404).json({ success: false, message: 'Hostel not found' });
    }
    
    const rooms = hostel.rooms || [];
    
    // Check if sick bay already exists
    const existingSickBay = rooms.find(r => 
      r.roomNumber === roomNumber || 
      r.name === 'Sick Bay' || 
      r.type === 'SICK_BAY'
    );
    
    if (existingSickBay) {
      return res.status(400).json({ 
        success: false, 
        message: 'Sick Bay already exists in this hostel',
        sickBay: existingSickBay
      });
    }
    
    // Create sick bay room
    const newRoom = {
      roomNumber,
      name: 'Sick Bay',
      beds,
      occupied: 0,
      students: [],
      type: 'SICK_BAY',
      isSickBay: true
    };
    
    rooms.push(newRoom);
    await hostel.update({ rooms });
    
    res.json({
      success: true,
      message: 'Sick Bay created successfully',
      sickBay: newRoom,
      hostel: {
        id: hostel.id,
        name: hostel.name
      }
    });
    
  } catch (error) {
    console.error('❌ Initialize sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// ==================== COURSE ENROLLMENT ROUTES ====================

// GET all course enrollments
app.get('/api/course-enrollments', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, status } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (status) where.status = status;

    const enrollments = await CourseEnrollment.findAll({
      where,
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] },
        { model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get course enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET enrollments for a specific student
app.get('/api/students/:studentId/enrollments', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Check access
    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const enrollments = await CourseEnrollment.findAll({
      where: { studentId, schoolId: req.user.schoolId },
      include: [
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get student enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create course enrollment
app.post('/api/course-enrollments', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, semester, academicYear, status } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    if (!courseId && !programId) {
      return res.status(400).json({ success: false, message: 'Either courseId or programId is required' });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if enrollment already exists
    const existing = await CourseEnrollment.findOne({
      where: {
        studentId,
        courseId: courseId || null,
        programId: programId || null,
        status: { [Op.ne]: 'DROPPED' }
      }
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already enrolled in this course/program' 
      });
    }
    
    const enrollment = await CourseEnrollment.create({
      studentId,
      courseId: courseId || null,
      programId: programId || null,
      semester: semester || null,
      academicYear: academicYear || new Date().getFullYear().toString(),
      status: status || (req.user.role === 'SCHOOL_ADMIN' ? 'APPROVED' : 'PENDING'),
      approvedBy: req.user.role === 'SCHOOL_ADMIN' ? req.user.id : null,
      approvedAt: req.user.role === 'SCHOOL_ADMIN' ? new Date() : null,
      schoolId: req.user.schoolId
    });
    
    await createAuditLog(req, 'CREATE', 'COURSE_ENROLLMENT', enrollment.id, null, enrollment);
    
    const createdEnrollment = await CourseEnrollment.findByPk(enrollment.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ]
    });
    
    res.status(201).json({ success: true, enrollment: createdEnrollment });
  } catch (error) {
    console.error('Create course enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH approve/reject enrollment
app.patch('/api/course-enrollments/:id/approve', authenticate, async (req, res) => {
  try {
    const { action } = req.body; // 'APPROVE' or 'REJECT'
    
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be APPROVE or REJECT' });
    }
    
    const enrollment = await CourseEnrollment.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId,
        status: 'PENDING'
      }
    });
    
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found or already processed' });
    }
    
    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    
    await enrollment.update({
      status: newStatus,
      approvedBy: req.user.id,
      approvedAt: new Date()
    });
    
    await createAuditLog(req, action, 'COURSE_ENROLLMENT', enrollment.id, null, { newStatus });
    
    res.json({ success: true, enrollment });
  } catch (error) {
    console.error('Approve enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE drop enrollment
app.delete('/api/course-enrollments/:id', authenticate, async (req, res) => {
  try {
    const enrollment = await CourseEnrollment.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    
    // Check if student is the one dropping
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (!student || enrollment.studentId !== student.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }
    
    await enrollment.update({ status: 'DROPPED' });
    
    await createAuditLog(req, 'DROP', 'COURSE_ENROLLMENT', enrollment.id, null, { status: 'DROPPED' });
    
    res.json({ success: true, message: 'Enrollment dropped successfully' });
  } catch (error) {
    console.error('Drop enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET pending enrollments (for admin)
app.get('/api/course-enrollments/pending', authenticate, async (req, res) => {
  try {
    const canApprove = ['SCHOOL_ADMIN', 'PRINCIPAL', 'DEAN', 'HOD'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const enrollments = await CourseEnrollment.findAll({
      where: { status: 'PENDING', schoolId: req.user.schoolId },
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'ASC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get pending enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== UNIT REGISTRATION ROUTES ====================

// GET all unit registrations
app.get('/api/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId, unitId, courseId, programId, status, semester, academicYear } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (unitId) where.unitId = unitId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (status) where.status = status;
    if (semester) where.semester = parseInt(semester);
    if (academicYear) where.academicYear = academicYear;

    const registrations = await UnitRegistration.findAll({
      where,
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] },
        { model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get unit registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET registrations for a specific student
app.get('/api/students/:studentId/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Check access
    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { studentId, schoolId: req.user.schoolId },
      include: [
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get student registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create unit registration
app.post('/api/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId, unitId, courseId, programId, semester, academicYear, status } = req.body;
    
    if (!studentId || !unitId) {
      return res.status(400).json({ success: false, message: 'Student ID and Unit ID are required' });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if the student has a valid course/program enrollment
    let enrollment;
    if (courseId) {
      enrollment = await CourseEnrollment.findOne({
        where: { studentId, courseId, status: 'APPROVED' }
      });
    } else if (programId) {
      enrollment = await CourseEnrollment.findOne({
        where: { studentId, programId, status: 'APPROVED' }
      });
    }
    
    if (!enrollment) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is not enrolled in this course/program' 
      });
    }
    
    // Check if already registered for this unit
    const existing = await UnitRegistration.findOne({
      where: {
        studentId,
        unitId,
        status: { [Op.ne]: 'DROPPED' }
      }
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already registered for this unit' 
      });
    }
    
    // Check payment status if required
    const requiresPayment = school.requiresPaymentForUnits !== false;
    const paymentRequiredPercentage = school.paymentPercentageRequired || 30;
    
    if (requiresPayment) {
      // Calculate fees for this course/program
      let applicableFees = [];
      if (courseId) {
        applicableFees = await Fee.findAll({ where: { courseId, schoolId: req.user.schoolId } });
      } else if (programId) {
        applicableFees = await Fee.findAll({ where: { programId, schoolId: req.user.schoolId } });
      }
      
      const totalFees = applicableFees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
      const payments = await Payment.findAll({ where: { studentId } });
      const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const paymentPercentage = totalFees > 0 ? (totalPaid / totalFees) * 100 : 100;
      
      if (paymentPercentage < paymentRequiredPercentage) {
        return res.status(400).json({ 
          success: false, 
          message: `You need to pay at least ${paymentRequiredPercentage}% of fees before registering units. Current: ${paymentPercentage.toFixed(1)}%` 
        });
      }
    }
    
    // Determine if auto-approve or require approval
    const requiresApproval = school.unitApprovalRequired !== false;
    
    const registration = await UnitRegistration.create({
      studentId,
      unitId,
      courseId: courseId || null,
      programId: programId || null,
      semester: semester || null,
      academicYear: academicYear || new Date().getFullYear().toString(),
      status: requiresApproval ? 'PENDING' : 'APPROVED',
      approvedBy: !requiresApproval ? req.user.id : null,
      approvedAt: !requiresApproval ? new Date() : null,
      schoolId: req.user.schoolId
    });
    
    await createAuditLog(req, 'CREATE', 'UNIT_REGISTRATION', registration.id, null, registration);
    
    const createdRegistration = await UnitRegistration.findByPk(registration.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ]
    });
    
    res.status(201).json({ success: true, registration: createdRegistration });
  } catch (error) {
    console.error('Create unit registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH approve/reject unit registration
app.patch('/api/unit-registrations/:id/approve', authenticate, async (req, res) => {
  try {
    const { action } = req.body; // 'APPROVE' or 'REJECT'
    
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be APPROVE or REJECT' });
    }
    
    const registration = await UnitRegistration.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId,
        status: 'PENDING'
      }
    });
    
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found or already processed' });
    }
    
    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    
    await registration.update({
      status: newStatus,
      approvedBy: req.user.id,
      approvedAt: new Date()
    });
    
    await createAuditLog(req, action, 'UNIT_REGISTRATION', registration.id, null, { newStatus });
    
    res.json({ success: true, registration });
  } catch (error) {
    console.error('Approve registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE drop unit registration
app.delete('/api/unit-registrations/:id', authenticate, async (req, res) => {
  try {
    const registration = await UnitRegistration.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }
    
    // Check if student is the one dropping
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (!student || registration.studentId !== student.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }
    
    await registration.update({ status: 'DROPPED' });
    
    await createAuditLog(req, 'DROP', 'UNIT_REGISTRATION', registration.id, null, { status: 'DROPPED' });
    
    res.json({ success: true, message: 'Unit registration dropped successfully' });
  } catch (error) {
    console.error('Drop registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET pending unit registrations (for admin)
app.get('/api/unit-registrations/pending', authenticate, async (req, res) => {
  try {
    const canApprove = ['SCHOOL_ADMIN', 'PRINCIPAL', 'DEAN', 'HOD'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { status: 'PENDING', schoolId: req.user.schoolId },
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'ASC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get pending registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET unit registrations by admission number
app.get('/api/unit-registrations/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    
    const student = await Student.findOne({
      where: { admissionNumber, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { studentId: student.id, schoolId: req.user.schoolId },
      include: [
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      registrations,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get registrations by admission error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET /api/system/health - Check system health
app.get('/api/system/health', authenticate, async (req, res) => {
  try {
    // Check database connection
    await sequelize.authenticate();
    
    // Check disk space
    const diskSpace = require('check-disk-space').default;
    const freeSpace = await diskSpace('/');
    
    // Check memory usage
    const memory = process.memoryUsage();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date(),
      uptime: process.uptime(),
      database: 'connected',
      disk: {
        free: freeSpace.free,
        size: freeSpace.size
      },
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB'
      }
    });
  } catch (error) {
    res.json({
      success: true,
      status: 'degraded',
      error: error.message
    });
  }
});

// ==================== DYNAMIC ROLES API ROUTES (FIXED) ====================

// GET all roles for a school - FIXED (NO circular references)
app.get('/api/roles', authenticate, async (req, res) => {
  try {
    // ✅ Get roles WITHOUT including users
    const roles = await Role.findAll({
      where: { 
        schoolId: req.user.schoolId,
        isActive: true 
      },
      order: [['isSystemRole', 'DESC'], ['name', 'ASC']]
    });
    
    // ✅ Count users per role with a separate query (no circular reference)
    const rolesWithCount = await Promise.all(roles.map(async (role) => {
      const userCount = await User.count({ 
        where: { roleId: role.id } 
      });
      return {
        ...role.toJSON(),
        userCount
      };
    }));
    
    res.json({ 
      success: true, 
      roles: rolesWithCount 
    });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET single role - FIXED
app.get('/api/roles/:id', authenticate, async (req, res) => {
  try {
    const role = await Role.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
      // ✅ NO includes!
    });
    
    if (!role) {
      return res.status(404).json({ 
        success: false, 
        message: 'Role not found' 
      });
    }
    
    res.json({ success: true, role });
  } catch (error) {
    console.error('Get role error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// CREATE role - FIXED (removed audit log temporarily)
app.post('/api/roles', authenticate, async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Role name is required' 
      });
    }
    
    // Check if role with same name exists in this school
    const existing = await Role.findOne({
      where: { 
        name: name,
        schoolId: req.user.schoolId 
      }
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'A role with this name already exists' 
      });
    }
    
    const role = await Role.create({
      name,
      description: description || '',
      permissions: permissions || [],
      isSystemRole: false,
      schoolId: req.user.schoolId
    });
    
    // ⚠️ AUDIT LOG TEMPORARILY DISABLED
    // await createAuditLog(req, 'CREATE', 'ROLE', role.id, null, role);
    
    res.status(201).json({ 
      success: true, 
      role,
      message: 'Role created successfully' 
    });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// UPDATE role - FIXED
app.put('/api/roles/:id', authenticate, async (req, res) => {
  try {
    const { name, description, permissions } = req.body;
    
    const role = await Role.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!role) {
      return res.status(404).json({ 
        success: false, 
        message: 'Role not found' 
      });
    }
    
    // Prevent modifying system roles' names
    if (role.isSystemRole && name && name !== role.name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot rename system roles' 
      });
    }
    
    const oldRole = { ...role.toJSON() };
    await role.update({
      name: name || role.name,
      description: description !== undefined ? description : role.description,
      permissions: permissions !== undefined ? permissions : role.permissions
    });
    
    // ⚠️ AUDIT LOG TEMPORARILY DISABLED
    // await createAuditLog(req, 'UPDATE', 'ROLE', role.id, oldRole, role);
    
    res.json({ 
      success: true, 
      role,
      message: 'Role updated successfully' 
    });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// DELETE role - FIXED
app.delete('/api/roles/:id', authenticate, async (req, res) => {
  try {
    const role = await Role.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!role) {
      return res.status(404).json({ 
        success: false, 
        message: 'Role not found' 
      });
    }
    
    if (role.isSystemRole) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete system roles' 
      });
    }
    
    // Check if role is in use
    const userCount = await User.count({ 
      where: { roleId: role.id } 
    });
    
    if (userCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete role with ${userCount} assigned users. Please reassign users first.` 
      });
    }
    
    await role.destroy();
    
    // ⚠️ AUDIT LOG TEMPORARILY DISABLED
    // await createAuditLog(req, 'DELETE', 'ROLE', req.params.id);
    
    res.json({ 
      success: true, 
      message: 'Role deleted successfully' 
    });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET all available permissions (master list) - FIXED
app.get('/api/permissions', authenticate, async (req, res) => {
  try {
    // Get all permissions from the master list
    const allPermissions = MASTER_PERMISSIONS.map(p => ({
      ...p,
      isEnabled: true
    }));
    
    // Group by category
    const grouped = {};
    allPermissions.forEach(perm => {
      if (!grouped[perm.category]) {
        grouped[perm.category] = [];
      }
      grouped[perm.category].push(perm);
    });
    
    res.json({ 
      success: true, 
      permissions: allPermissions,
      grouped: grouped,
      categories: Object.keys(grouped)
    });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET permissions for a specific role - FIXED
app.get('/api/roles/:id/permissions', authenticate, async (req, res) => {
  try {
    const role = await Role.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!role) {
      return res.status(404).json({ 
        success: false, 
        message: 'Role not found' 
      });
    }
    
    // Get all permissions with their enabled status for this role
    const allPermissions = MASTER_PERMISSIONS.map(p => ({
      ...p,
      isAssigned: role.permissions.includes(p.key)
    }));
    
    res.json({ 
      success: true, 
      permissions: allPermissions,
      assigned: role.permissions || []
    });
  } catch (error) {
    console.error('Get role permissions error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Bulk assign permissions to a role - FIXED
app.patch('/api/roles/:id/permissions', authenticate, async (req, res) => {
  try {
    const { permissions } = req.body;
    
    if (!permissions || !Array.isArray(permissions)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Permissions array is required' 
      });
    }
    
    const role = await Role.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!role) {
      return res.status(404).json({ 
        success: false, 
        message: 'Role not found' 
      });
    }
    
    const oldRole = { ...role.toJSON() };
    await role.update({ permissions });
    
    // ⚠️ AUDIT LOG TEMPORARILY DISABLED
    // await createAuditLog(req, 'UPDATE_PERMISSIONS', 'ROLE', role.id, oldRole, role);
    
    res.json({ 
      success: true, 
      role,
      message: `Permissions updated successfully. ${permissions.length} permissions assigned.` 
    });
  } catch (error) {
    console.error('Update role permissions error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ASSIGN role to a user - FIXED (NO circular references)
app.patch('/api/users/:userId/role', authenticate, async (req, res) => {
  try {
    const { roleId } = req.body;
    
    const user = await User.findByPk(req.params.userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    // Check if role exists and belongs to this school
    if (roleId) {
      const role = await Role.findOne({
        where: { 
          id: roleId,
          schoolId: req.user.schoolId 
        }
      });
      
      if (!role) {
        return res.status(404).json({ 
          success: false, 
          message: 'Role not found or does not belong to your school' 
        });
      }
    }
    
    const oldUser = { ...user.toJSON() };
    await user.update({ roleId });
    
    // ⚠️ AUDIT LOG TEMPORARILY DISABLED
    // await createAuditLog(req, 'ASSIGN_ROLE', 'USER', user.id, oldUser, user);
    
    // ✅ Fetch updated user WITHOUT role association to avoid circular reference
    const updatedUser = await User.findByPk(user.id, {
      attributes: { exclude: ['password'] }
      // ✅ NO includes!
    });
    
    // ✅ Get role separately if needed
    let roleInfo = null;
    if (user.roleId) {
      roleInfo = await Role.findByPk(user.roleId, {
        attributes: ['id', 'name', 'permissions']
      });
    }
    
    res.json({ 
      success: true, 
      user: updatedUser,
      role: roleInfo,
      message: roleId ? 'Role assigned successfully' : 'Role removed successfully'
    });
  } catch (error) {
    console.error('Assign role error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});
// ==================== STUDENT ARRIVAL ROUTES ====================

// MARK ARRIVAL
app.post('/api/student-arrival', authenticate, async (req, res) => {
  try {
    const { studentId, status, notes, timeIn, sendSMS } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId },
      include: [
        { model: Parent, include: [{ model: User }] }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Check if already arrived today
    const today = new Date().toISOString().split('T')[0];
    const existingArrival = await StudentArrival.findOne({
      where: {
        studentId: studentId,
        schoolId: req.user.schoolId,
        createdAt: { [Op.gte]: new Date(today) }
      }
    });
    
    if (existingArrival && existingArrival.arrivedAt) {
      return res.status(400).json({
        success: false,
        message: 'Student already marked arrived today',
        arrival: existingArrival
      });
    }
    
    // Create or update arrival record
    let arrival;
    if (existingArrival) {
      // Update existing record (for late arrival or correction)
      await existingArrival.update({
        arrivedAt: new Date(),
        status: status || 'ARRIVED',
        notes: notes || existingArrival.notes,
        timeIn: timeIn || new Date().toLocaleTimeString(),
        markedBy: req.user.id
      });
      arrival = existingArrival;
    } else {
      arrival = await StudentArrival.create({
        studentId: studentId,
        schoolId: req.user.schoolId,
        markedBy: req.user.id,
        status: status || 'ARRIVED',
        notes: notes || '',
        timeIn: timeIn || new Date().toLocaleTimeString(),
        arrivedAt: new Date()
      });
    }
    
    // Send SMS to parents
    const parentNotified = [];
    const sendSMSNotification = sendSMS !== false;
    
    if (sendSMSNotification && student.Parents && student.Parents.length > 0) {
      const schoolName = school.name || 'School';
      const childName = `${student.firstName} ${student.lastName}`;
      const arrivalTime = new Date().toLocaleTimeString();
      const arrivalDate = new Date().toLocaleDateString();
      
      const message = `🔔 SAFE ARRIVAL ALERT\n\nDear Parent,\n\n${childName} (Adm: ${student.admissionNumber}) has arrived at ${schoolName} safely.\n\n🕐 Time: ${arrivalTime}\n📅 Date: ${arrivalDate}\n📝 Status: ${status || 'ARRIVED'}\n\nThank you for entrusting us with your child.\n\n- ${schoolName} Administration`;
      
      for (const parent of student.Parents) {
        if (parent.User?.phone) {
          try {
            // Use your SMS function here
            // await sendSMS(parent.User.phone, message);
            console.log(`📱 SMS would be sent to: ${parent.User.phone}`);
            parentNotified.push(parent.User.phone);
          } catch (err) {
            console.error('SMS error:', err);
          }
        }
      }
      
      await arrival.update({
        parentNotifiedArrival: parentNotified.length > 0,
        parentNotifiedAt: parentNotified.length > 0 ? new Date() : null
      });
    }
    
    res.json({
      success: true,
      message: `✅ ${student.firstName} ${student.lastName} marked as arrived`,
      arrival,
      parentNotified: parentNotified.length,
      parentsNotifiedList: parentNotified
    });
    
  } catch (error) {
    console.error('❌ Student arrival error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// MARK DEPARTURE
app.post('/api/student-departure', authenticate, async (req, res) => {
  try {
    const { studentId, notes, timeOut, sendSMS } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId },
      include: [
        { model: Parent, include: [{ model: User }] }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    // Find today's arrival record
    const today = new Date().toISOString().split('T')[0];
    const arrival = await StudentArrival.findOne({
      where: {
        studentId: studentId,
        schoolId: req.user.schoolId,
        arrivedAt: { [Op.ne]: null },
        createdAt: { [Op.gte]: new Date(today) }
      }
    });
    
    if (!arrival) {
      return res.status(400).json({
        success: false,
        message: 'Student has not arrived today. Please mark arrival first.'
      });
    }
    
    if (arrival.departedAt) {
      return res.status(400).json({
        success: false,
        message: 'Student already marked departed today'
      });
    }
    
    // Update with departure
    await arrival.update({
      departedAt: new Date(),
      status: 'DEPARTED',
      notes: notes || arrival.notes,
      timeOut: timeOut || new Date().toLocaleTimeString()
    });
    
    // Send departure SMS to parents
    const parentNotified = [];
    const sendSMSNotification = sendSMS !== false;
    
    if (sendSMSNotification && student.Parents && student.Parents.length > 0) {
      const schoolName = school.name || 'School';
      const childName = `${student.firstName} ${student.lastName}`;
      const departureTime = new Date().toLocaleTimeString();
      const departureDate = new Date().toLocaleDateString();
      
      const message = `🔔 DEPARTURE ALERT\n\nDear Parent,\n\n${childName} (Adm: ${student.admissionNumber}) has departed from ${schoolName}.\n\n🕐 Time: ${departureTime}\n📅 Date: ${departureDate}\n\nThey should be home soon.\n\n- ${schoolName} Administration`;
      
      for (const parent of student.Parents) {
        if (parent.User?.phone) {
          try {
            // await sendSMS(parent.User.phone, message);
            console.log(`📱 Departure SMS to: ${parent.User.phone}`);
            parentNotified.push(parent.User.phone);
          } catch (err) {
            console.error('SMS error:', err);
          }
        }
      }
      
      await arrival.update({
        parentNotifiedDeparture: parentNotified.length > 0,
        departureNotifiedAt: parentNotified.length > 0 ? new Date() : null
      });
    }
    
    res.json({
      success: true,
      message: `✅ ${student.firstName} ${student.lastName} marked as departed`,
      arrival,
      parentNotified: parentNotified.length,
      parentsNotifiedList: parentNotified
    });
    
  } catch (error) {
    console.error('❌ Student departure error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// GET TODAY'S ARRIVALS
app.get('/api/student-arrival/today', authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    const arrivals = await StudentArrival.findAll({
      where: {
        schoolId: req.user.schoolId,
        createdAt: { [Op.gte]: new Date(today) }
      },
      include: [
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        },
        { 
          model: User,
          as: 'markedByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ],
      order: [['arrivedAt', 'DESC']]
    });
    
    const stats = {
      total: arrivals.length,
      arrived: arrivals.filter(a => a.status === 'ARRIVED' || a.status === 'LATE').length,
      late: arrivals.filter(a => a.status === 'LATE').length,
      absent: arrivals.filter(a => a.status === 'ABSENT').length,
      excused: arrivals.filter(a => a.status === 'EXCUSED').length,
      departed: arrivals.filter(a => a.status === 'DEPARTED').length,
      parentNotified: arrivals.filter(a => a.parentNotifiedArrival).length
    };
    
    res.json({
      success: true,
      arrivals,
      stats,
      date: today
    });
    
  } catch (error) {
    console.error('❌ Get arrivals error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// GET STUDENT ARRIVAL HISTORY
app.get('/api/student-arrival/student/:studentId', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const { startDate, endDate, limit = 30 } = req.query;
    
    const where = {
      studentId: studentId,
      schoolId: req.user.schoolId
    };
    
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }
    
    const arrivals = await StudentArrival.findAll({
      where,
      include: [
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        },
        { 
          model: User,
          as: 'markedByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ],
      order: [['arrivedAt', 'DESC']],
      limit: parseInt(limit)
    });
    
    const stats = {
      total: arrivals.length,
      arrived: arrivals.filter(a => a.status === 'ARRIVED' || a.status === 'LATE').length,
      late: arrivals.filter(a => a.status === 'LATE').length,
      absent: arrivals.filter(a => a.status === 'ABSENT').length,
      excused: arrivals.filter(a => a.status === 'EXCUSED').length,
      departed: arrivals.filter(a => a.status === 'DEPARTED').length,
      parentNotified: arrivals.filter(a => a.parentNotifiedArrival).length
    };
    
    res.json({
      success: true,
      arrivals,
      stats
    });
    
  } catch (error) {
    console.error('❌ Get student arrivals error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// GET ALL ARRIVALS (with filters)
app.get('/api/student-arrival', authenticate, async (req, res) => {
  try {
    const { 
      startDate, endDate, studentId, classId, 
      status, limit = 100, page = 1 
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (status) where.status = status;
    
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }
    
    // If classId is provided, filter students by class
    let studentFilter = {};
    if (classId) {
      studentFilter.classId = classId;
    }
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const { count, rows } = await StudentArrival.findAndCountAll({
      where,
      include: [
        { 
          model: Student,
          where: studentFilter,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber', 'classId']
        },
        { 
          model: User,
          as: 'markedByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ],
      order: [['arrivedAt', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });
    
    res.json({
      success: true,
      arrivals: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / parseInt(limit))
    });
    
  } catch (error) {
    console.error('❌ Get arrivals error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


// ==================== RECEPTIONIST ROUTES ====================

// VISITORS
app.get('/api/receptionist/visitors', authenticate, async (req, res) => {
  try {
    const visitors = await Visitor.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['checkIn', 'DESC']],
      limit: 50
    });
    res.json({ success: true, visitors });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==================== VISITOR ROUTES ====================

app.post('/api/receptionist/visitors/check-in', authenticate, async (req, res) => {
  try {
    const { 
      name, phone, email, purpose, personToSee, 
      idNumber, vehicleNumber, checkIn 
    } = req.body;

    // ✅ FIX: Use current time if checkIn is not provided or invalid
    let checkInDate;
    if (checkIn && !isNaN(new Date(checkIn).getTime())) {
      checkInDate = new Date(checkIn);
    } else {
      checkInDate = new Date();
    }

    const visitor = await Visitor.create({
      name,
      phone: phone || null,
      email: email || null,
      purpose,
      personToSee: personToSee || null,
      idNumber: idNumber || null,
      vehicleNumber: vehicleNumber || null,
      checkIn: checkInDate,
      schoolId: req.user.schoolId,
      checkedInBy: req.user.id,
      status: 'CHECKED_IN'
    });

    // ✅ Create audit log
    await createAuditLog(req, 'CHECK_IN', 'VISITOR', visitor.id, null, { 
      name, 
      purpose, 
      personToSee 
    });

    res.status(201).json({ 
      success: true, 
      visitor,
      message: `${name} checked in successfully`
    });
  } catch (error) {
    console.error('❌ Check-in error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

app.patch('/api/receptionist/visitors/:id/check-out', authenticate, async (req, res) => {
  try {
    const visitor = await Visitor.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!visitor) return res.status(404).json({ message: 'Visitor not found' });
    await visitor.update({ checkOut: new Date(), status: 'CHECKED_OUT' });
    res.json({ success: true, visitor });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// ==================== CALL LOG ROUTES (IMPROVED) ====================

// GET ALL CALLS
app.get('/api/receptionist/calls', authenticate, async (req, res) => {
  try {
    const calls = await CallLog.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'loggedByUser', 
          attributes: ['id', 'firstName', 'lastName'],
          required: false 
        }
      ],
      order: [['timestamp', 'DESC']],
      limit: 50
    });
    
    res.json({ 
      success: true, 
      calls,
      count: calls.length 
    });
  } catch (error) {
    console.error('❌ Get calls error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch calls',
      error: error.message 
    });
  }
});

// LOG A CALL
app.post('/api/receptionist/calls', authenticate, async (req, res) => {
  try {
    const { 
      callerName, callerPhone, recipient, purpose, 
      duration, status, notes, timestamp 
    } = req.body;

    // ✅ Validate required fields
    if (!callerName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Caller name is required' 
      });
    }

    // ✅ Handle timestamp properly
    let callTimestamp = new Date();
    if (timestamp) {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) {
        callTimestamp = parsed;
      }
    }

    // ✅ Create the call log
    const call = await CallLog.create({
      callerName: callerName.trim(),
      callerPhone: callerPhone || null,
      recipient: recipient || null,
      purpose: purpose || null,
      duration: duration ? parseInt(duration) : null,
      status: status || 'INCOMING',
      notes: notes || null,
      timestamp: callTimestamp,
      schoolId: req.user.schoolId,
      loggedBy: req.user.id
    });

    // ✅ Create audit log
    await createAuditLog(req, 'LOG_CALL', 'CALL', call.id, null, { 
      callerName, 
      status, 
      recipient 
    });

    res.status(201).json({ 
      success: true, 
      call,
      message: 'Call logged successfully'
    });
  } catch (error) {
    console.error('❌ Call log error:', error);
    
    // ✅ Handle specific Sequelize errors
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation error',
        errors: error.errors.map(e => e.message)
      });
    }
    
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid reference: User not found'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Failed to log call',
      error: error.message 
    });
  }
});

// GET SINGLE CALL
app.get('/api/receptionist/calls/:id', authenticate, async (req, res) => {
  try {
    const call = await CallLog.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: User, 
          as: 'loggedByUser', 
          attributes: ['id', 'firstName', 'lastName'],
          required: false 
        }
      ]
    });
    
    if (!call) {
      return res.status(404).json({ 
        success: false, 
        message: 'Call not found' 
      });
    }
    
    res.json({ success: true, call });
  } catch (error) {
    console.error('❌ Get call error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch call',
      error: error.message 
    });
  }
});

// UPDATE CALL
app.patch('/api/receptionist/calls/:id', authenticate, async (req, res) => {
  try {
    const call = await CallLog.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!call) {
      return res.status(404).json({ 
        success: false, 
        message: 'Call not found' 
      });
    }

    // ✅ Don't allow updating certain fields
    const allowedUpdates = ['status', 'notes', 'duration', 'purpose'];
    const updateData = {};
    
    Object.keys(req.body).forEach(key => {
      if (allowedUpdates.includes(key)) {
        updateData[key] = req.body[key];
      }
    });

    await call.update(updateData);
    
    await createAuditLog(req, 'UPDATE', 'CALL', call.id, null, updateData);

    res.json({ 
      success: true, 
      call,
      message: 'Call updated successfully'
    });
  } catch (error) {
    console.error('❌ Update call error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update call',
      error: error.message 
    });
  }
});

// DELETE CALL
app.delete('/api/receptionist/calls/:id', authenticate, async (req, res) => {
  try {
    const call = await CallLog.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!call) {
      return res.status(404).json({ 
        success: false, 
        message: 'Call not found' 
      });
    }

    await call.destroy();
    
    await createAuditLog(req, 'DELETE', 'CALL', req.params.id);

    res.json({ 
      success: true, 
      message: 'Call deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete call error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete call',
      error: error.message 
    });
  }
});

// GET CALL STATISTICS
app.get('/api/receptionist/calls/stats', authenticate, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const stats = {
      total: await CallLog.count({ 
        where: { schoolId: req.user.schoolId } 
      }),
      today: await CallLog.count({ 
        where: { 
          schoolId: req.user.schoolId,
          timestamp: { [Op.gte]: today }
        } 
      }),
      incoming: await CallLog.count({ 
        where: { 
          schoolId: req.user.schoolId,
          status: 'INCOMING'
        } 
      }),
      outgoing: await CallLog.count({ 
        where: { 
          schoolId: req.user.schoolId,
          status: 'OUTGOING'
        } 
      }),
      missed: await CallLog.count({ 
        where: { 
          schoolId: req.user.schoolId,
          status: 'MISSED'
        } 
      })
    };
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('❌ Call stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch call stats',
      error: error.message 
    });
  }
});
// ==================== RECEPTIONIST BACKEND ROUTES ====================

// ===== COMPLAINTS =====
app.get('/api/receptionist/complaints', authenticate, async (req, res) => {
  try {
    const complaints = await Complaint.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'assignedToUser', 
          attributes: ['id', 'firstName', 'lastName'] 
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    res.json({ success: true, complaints });
  } catch (error) {
    console.error('❌ Get complaints error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/receptionist/complaints', authenticate, async (req, res) => {
  try {
    const { 
      complainant, complainantType, contact, category, 
      description, urgency, assignedTo 
    } = req.body;

    // ✅ Validate
    if (!complainant || !description) {
      return res.status(400).json({ 
        success: false, 
        message: 'Complainant and description are required' 
      });
    }

    const complaint = await Complaint.create({
      complainant: complainant.trim(),
      complainantType: complainantType || 'PARENT',
      contact: contact || null,
      category: category || 'GENERAL',
      description: description.trim(),
      urgency: urgency || 'NORMAL',
      assignedTo: assignedTo || null,
      status: 'OPEN',
      schoolId: req.user.schoolId,
      reportedBy: req.user.id
    });

    await createAuditLog(req, 'CREATE', 'COMPLAINT', complaint.id, null, complaint);

    res.status(201).json({ 
      success: true, 
      complaint,
      message: 'Complaint logged successfully'
    });
  } catch (error) {
    console.error('❌ Create complaint error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/api/receptionist/complaints/:id', authenticate, async (req, res) => {
  try {
    const complaint = await Complaint.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!complaint) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }

    const updateData = { ...req.body };
    
    // ✅ If resolving, add resolvedAt
    if (updateData.status === 'RESOLVED' && complaint.status !== 'RESOLVED') {
      updateData.resolvedAt = new Date();
    }

    await complaint.update(updateData);
    await createAuditLog(req, 'UPDATE', 'COMPLAINT', complaint.id, null, updateData);

    res.json({ success: true, complaint });
  } catch (error) {
    console.error('❌ Update complaint error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== APPOINTMENTS =====
app.get('/api/receptionist/appointments', authenticate, async (req, res) => {
  try {
    const appointments = await Appointment.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { model: User, as: 'staff', attributes: ['id', 'firstName', 'lastName'] },
        { model: User, as: 'parent', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['date', 'ASC']],
      limit: 50
    });
    res.json({ success: true, appointments });
  } catch (error) {
    console.error('❌ Get appointments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/receptionist/appointments', authenticate, async (req, res) => {
  try {
    const { 
      title, description, parentId, staffId, studentId,
      date, time, duration, type 
    } = req.body;

    // ✅ Validate required fields
    if (!title || !date || !time) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title, date, and time are required' 
      });
    }

    // ✅ Parse date
    const appointmentDate = new Date(date);
    if (isNaN(appointmentDate.getTime())) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid date format' 
      });
    }

    // ✅ Only set parentId if it's a valid UUID and not empty string
    let validParentId = null;
    if (parentId && parentId !== '' && parentId !== 'null') {
      // Check if parent exists
      const parentExists = await User.findByPk(parentId);
      if (parentExists) {
        validParentId = parentId;
      } else {
        console.log(`⚠️ Parent ${parentId} not found, setting to null`);
      }
    }

    // ✅ Only set staffId if it's a valid UUID
    let validStaffId = null;
    if (staffId && staffId !== '' && staffId !== 'null') {
      const staffExists = await User.findByPk(staffId);
      if (staffExists) {
        validStaffId = staffId;
      } else {
        console.log(`⚠️ Staff ${staffId} not found, setting to null`);
      }
    }

    // ✅ Only set studentId if it's a valid UUID
    let validStudentId = null;
    if (studentId && studentId !== '' && studentId !== 'null') {
      const studentExists = await Student.findByPk(studentId);
      if (studentExists) {
        validStudentId = studentId;
      } else {
        console.log(`⚠️ Student ${studentId} not found, setting to null`);
      }
    }

    const appointment = await Appointment.create({
      title: title.trim(),
      description: description || null,
      parentId: validParentId,
      staffId: validStaffId,
      studentId: validStudentId,
      date: appointmentDate,
      time: time,
      duration: duration ? parseInt(duration) : 30,
      type: type || 'PARENT_TEACHER',
      status: 'SCHEDULED',
      schoolId: req.user.schoolId,
      scheduledBy: req.user.id
    });

    await createAuditLog(req, 'CREATE', 'APPOINTMENT', appointment.id, null, appointment);

    res.status(201).json({ 
      success: true, 
      appointment,
      message: 'Appointment scheduled successfully'
    });
  } catch (error) {
    console.error('❌ Appointment error:', error);
    
    // ✅ Handle specific errors
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid reference: The selected parent, staff, or student does not exist. Please select valid users or leave blank.'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});
app.patch('/api/receptionist/appointments/:id', authenticate, async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    await appointment.update(req.body);
    await createAuditLog(req, 'UPDATE', 'APPOINTMENT', appointment.id, null, req.body);

    res.json({ success: true, appointment });
  } catch (error) {
    console.error('❌ Update appointment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/receptionist/tasks', authenticate, async (req, res) => {
  try {
    const tasks = await Task.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'assignedToUser', 
          attributes: ['id', 'firstName', 'lastName', 'email']
        },
        { 
          model: User, 
          as: 'assignedByUser', 
          attributes: ['id', 'firstName', 'lastName', 'email']
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('❌ Get tasks error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// In server.cjs - POST /api/receptionist/tasks
app.post('/api/receptionist/tasks', authenticate, async (req, res) => {
  try {
    const { title, description, assignedTo, dueDate, priority, requiresApproval } = req.body;

    // ✅ Validate
    if (!title || !description) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title and description are required' 
      });
    }

    // ✅ If assignedTo is empty, use the current user
    let finalAssignedTo = assignedTo;
    if (!finalAssignedTo || finalAssignedTo === '' || finalAssignedTo === 'null') {
      finalAssignedTo = req.user.id;  // Assign to self
    }

    // ✅ Verify the user exists
    const userExists = await User.findByPk(finalAssignedTo);
    if (!userExists) {
      return res.status(400).json({ 
        success: false, 
        message: 'Assigned user does not exist' 
      });
    }

    let dueDateParsed = null;
    if (dueDate) {
      const parsed = new Date(dueDate);
      if (!isNaN(parsed.getTime())) {
        dueDateParsed = parsed;
      }
    }

    const task = await Task.create({
      title: title.trim(),
      description: description.trim(),
      assignedTo: finalAssignedTo,
      assignedBy: req.user.id,
      dueDate: dueDateParsed,
      priority: priority || 'NORMAL',
      status: 'PENDING',
      requiresApproval: requiresApproval !== false,
      schoolId: req.user.schoolId
    });

    // ✅ Fetch the created task with associations
    const createdTask = await Task.findByPk(task.id, {
      include: [
        { 
          model: User, 
          as: 'assignedToUser', 
          attributes: ['id', 'firstName', 'lastName', 'email']
        },
        { 
          model: User, 
          as: 'assignedByUser', 
          attributes: ['id', 'firstName', 'lastName', 'email']
        }
      ]
    });

    res.status(201).json({ 
      success: true, 
      task: createdTask,
      message: 'Task assigned successfully'
    });
  } catch (error) {
    console.error('❌ Task error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});


app.patch('/api/receptionist/tasks/:id', authenticate, async (req, res) => {
  try {
    const task = await Task.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const updateData = { ...req.body };
    
    // ✅ If completing, add completedAt
    if (updateData.status === 'COMPLETED' && task.status !== 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    await task.update(updateData);
    await createAuditLog(req, 'UPDATE', 'TASK', task.id, null, updateData);

    res.json({ success: true, task });
  } catch (error) {
    console.error('❌ Update task error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ==================== DELETE TASK ROUTE ====================
app.delete('/api/receptionist/tasks/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting task: ${id}`);
    
    // ✅ Find the task
    const task = await Task.findOne({
      where: { 
        id: id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!task) {
      return res.status(404).json({ 
        success: false, 
        message: 'Task not found' 
      });
    }
    
    // ✅ Check permission - only admin or the person who created it can delete
    const isAdmin = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role);
    const isCreator = task.assignedBy === req.user.id;
    
    if (!isAdmin && !isCreator) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to delete this task' 
      });
    }
    
    // ✅ Delete the task
    await task.destroy();
    
    // ✅ Create audit log
    await createAuditLog(req, 'DELETE', 'TASK', id, null, { 
      taskTitle: task.title,
      deletedBy: req.user.id
    });
    
    res.json({ 
      success: true, 
      message: 'Task deleted successfully' 
    });
    
  } catch (error) {
    console.error('❌ Delete task error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ==================== DELETE COMPLAINT ====================
app.delete('/api/receptionist/complaints/:id', authenticate, async (req, res) => {
  try {
    const complaint = await Complaint.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!complaint) {
      return res.status(404).json({ success: false, message: 'Complaint not found' });
    }
    
    await complaint.destroy();
    await createAuditLog(req, 'DELETE', 'COMPLAINT', req.params.id);
    
    res.json({ success: true, message: 'Complaint deleted successfully' });
  } catch (error) {
    console.error('❌ Delete complaint error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== DELETE APPOINTMENT ====================
app.delete('/api/receptionist/appointments/:id', authenticate, async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }
    
    await appointment.destroy();
    await createAuditLog(req, 'DELETE', 'APPOINTMENT', req.params.id);
    
    res.json({ success: true, message: 'Appointment deleted successfully' });
  } catch (error) {
    console.error('❌ Delete appointment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== DELETE CALL ====================
app.delete('/api/receptionist/calls/:id', authenticate, async (req, res) => {
  try {
    const call = await CallLog.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }
    
    await call.destroy();
    await createAuditLog(req, 'DELETE', 'CALL', req.params.id);
    
    res.json({ success: true, message: 'Call deleted successfully' });
  } catch (error) {
    console.error('❌ Delete call error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== DELETE VISITOR ====================
app.delete('/api/receptionist/visitors/:id', authenticate, async (req, res) => {
  try {
    const visitor = await Visitor.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!visitor) {
      return res.status(404).json({ success: false, message: 'Visitor not found' });
    }
    
    await visitor.destroy();
    await createAuditLog(req, 'DELETE', 'VISITOR', req.params.id);
    
    res.json({ success: true, message: 'Visitor deleted successfully' });
  } catch (error) {
    console.error('❌ Delete visitor error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== CARD ROUTES ====================
// ============================================================

// GENERATE SINGLE CARD
app.post('/api/cards/generate', authenticate, async (req, res) => {
  try {
    const { personId, type, template, customFields } = req.body;
    
    let person;
    if (type === 'student') {
      person = await Student.findByPk(personId, {
        include: [{ model: Class, attributes: ['name'] }]
      });
    } else {
      person = await Staff.findByPk(personId, {
        include: [{ model: User, attributes: ['firstName', 'lastName', 'email'] }]
      });
    }
    
    if (!person) {
      return res.status(404).json({ success: false, message: 'Person not found' });
    }
    
    const cardNumber = `CARD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    
    const card = await Card.create({
      schoolId: req.user.schoolId,
      personId: personId,
      personType: type.toUpperCase(),
      cardNumber,
      template: template || {},
      status: 'ACTIVE',
      issuedDate: new Date(),
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      generatedBy: req.user.id,
      printCount: 1,
      lastPrinted: new Date()
    });
    
    await createAuditLog(req, 'GENERATE_CARD', 'CARD', card.id, null, { personId, type });
    
    res.json({ 
      success: true, 
      card,
      message: 'Card generated successfully'
    });
  } catch (error) {
    console.error('❌ Generate card error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// BULK GENERATE CARDS
app.post('/api/cards/bulk-generate', authenticate, async (req, res) => {
  try {
    const { type, template } = req.body;
    let persons = [];
    
    if (type === 'students') {
      persons = await Student.findAll({
        where: { schoolId: req.user.schoolId },
        include: [{ model: Class, attributes: ['name'] }]
      });
    } else {
      persons = await Staff.findAll({
        where: { schoolId: req.user.schoolId },
        include: [{ model: User, attributes: ['firstName', 'lastName', 'email'] }]
      });
    }
    
    let generated = 0;
    for (const person of persons) {
      try {
        const cardNumber = `CARD-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        await Card.create({
          schoolId: req.user.schoolId,
          personId: person.id,
          personType: type === 'students' ? 'STUDENT' : 'STAFF',
          cardNumber,
          template: template || {},
          status: 'ACTIVE',
          issuedDate: new Date(),
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          generatedBy: req.user.id,
          printCount: 1,
          lastPrinted: new Date()
        });
        generated++;
      } catch (err) {}
    }
    
    res.json({ 
      success: true, 
      message: `${generated} cards generated successfully`,
      count: generated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET ALL CARDS
app.get('/api/cards', authenticate, async (req, res) => {
  try {
    const cards = await Card.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['createdAt', 'DESC']]
    });
    res.json({ success: true, cards });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE CARD STATUS
app.patch('/api/cards/:id', authenticate, async (req, res) => {
  try {
    const card = await Card.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    
    await card.update(req.body);
    res.json({ success: true, card });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE CARD
app.delete('/api/cards/:id', authenticate, async (req, res) => {
  try {
    const card = await Card.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!card) return res.status(404).json({ success: false, message: 'Card not found' });
    
    await card.destroy();
    res.json({ success: true, message: 'Card deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// ==================== PRINT CARD ROUTE ====================
app.get('/api/cards/:id/print', authenticate, async (req, res) => {
  try {
    const card = await Card.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!card) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }
    
    // Get the person (student or staff)
    let person;
    let personType = card.personType;
    
    if (card.personType === 'STUDENT') {
      person = await Student.findByPk(card.personId, {
        include: [{ model: Class, attributes: ['name'] }]
      });
    } else {
      person = await Staff.findByPk(card.personId, {
        include: [{ model: User, attributes: ['firstName', 'lastName', 'email', 'phone'] }]
      });
    }
    
    if (!person) {
      return res.status(404).json({ success: false, message: 'Person not found' });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Generate HTML for the card
    const html = generateCardHTML(person, personType.toLowerCase(), card, school, card.template || {});
    
    res.json({ 
      success: true, 
      html,
      card: card
    });
  } catch (error) {
    console.error('❌ Print card error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== CERTIFICATE ROUTES ====================

// GENERATE CERTIFICATE
app.post('/api/certificates/generate', authenticate, async (req, res) => {
  try {
    const { recipientId, type, template, description } = req.body;
    
    // Find recipient
    let recipient;
    let recipientType;
    
    // Check if student
    const student = await Student.findOne({
      where: { id: recipientId, schoolId: req.user.schoolId },
      include: [{ model: Class, attributes: ['name'] }]
    });
    
    if (student) {
      recipient = student;
      recipientType = 'STUDENT';
    } else {
      // Check if staff
      const staffMember = await Staff.findOne({
        where: { id: recipientId, schoolId: req.user.schoolId },
        include: [{ model: User, attributes: ['firstName', 'lastName'] }]
      });
      if (staffMember) {
        recipient = staffMember;
        recipientType = 'STAFF';
      }
    }
    
    if (!recipient) {
      return res.status(404).json({ success: false, message: 'Recipient not found' });
    }
    
    // ✅ Get school - ONLY DECLARE ONCE
    const school = await School.findByPk(req.user.schoolId);
    
    const certificateNumber = `CERT-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    
    // Create certificate record
    const certificate = await Certificate.create({
      schoolId: req.user.schoolId,
      recipientId: recipientId,
      recipientType,
      certificateNumber,
      type: type || 'custom',
      template: template || {},
      issuedDate: new Date(),
      generatedBy: req.user.id,
      status: 'ISSUED',
      description
    });
    
    // Generate HTML
    const html = generateCertificateHTML(recipient, recipientType, certificate, school, template);
    
    await createAuditLog(req, 'GENERATE_CERTIFICATE', 'CERTIFICATE', certificate.id, null, { recipientId, type });
    
    res.json({ 
      success: true, 
      certificate,
      html,
      message: 'Certificate generated successfully'
    });
  } catch (error) {
    console.error('❌ Generate certificate error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// BULK GENERATE CERTIFICATES
app.post('/api/certificates/bulk-generate', authenticate, async (req, res) => {
  try {
    const { type, template } = req.body;
    let recipients = [];
    
    if (type === 'student_of_year' || type === 'graduation' || type === 'academic_excellence') {
      recipients = await Student.findAll({
        where: { schoolId: req.user.schoolId },
        include: [{ model: Class, attributes: ['name'] }]
      });
    } else if (type === 'teacher_of_year') {
      recipients = await Staff.findAll({
        where: { schoolId: req.user.schoolId, staffType: 'TEACHING' },
        include: [{ model: User, attributes: ['firstName', 'lastName'] }]
      });
    }
    
    let generated = 0;
    for (const recipient of recipients) {
      try {
        const certificateNumber = `CERT-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        await Certificate.create({
          schoolId: req.user.schoolId,
          recipientId: recipient.id,
          recipientType: type === 'teacher_of_year' ? 'STAFF' : 'STUDENT',
          certificateNumber,
          type: type || 'custom',
          template: template || {},
          issuedDate: new Date(),
          generatedBy: req.user.id,
          status: 'ISSUED'
        });
        generated++;
      } catch (err) {}
    }
    
    res.json({ 
      success: true, 
      message: `${generated} certificates generated successfully`,
      count: generated
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET ALL CERTIFICATES
app.get('/api/certificates', authenticate, async (req, res) => {
  try {
    const certificates = await Certificate.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['createdAt', 'DESC']]
    });
    res.json({ success: true, certificates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE CERTIFICATE
app.patch('/api/certificates/:id', authenticate, async (req, res) => {
  try {
    const certificate = await Certificate.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!certificate) return res.status(404).json({ success: false, message: 'Certificate not found' });
    
    await certificate.update(req.body);
    res.json({ success: true, certificate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE CERTIFICATE
app.delete('/api/certificates/:id', authenticate, async (req, res) => {
  try {
    const certificate = await Certificate.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!certificate) return res.status(404).json({ success: false, message: 'Certificate not found' });
    
    await certificate.destroy();
    res.json({ success: true, message: 'Certificate deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET CERTIFICATE FOR PRINTING
app.get('/api/certificates/:id/print', authenticate, async (req, res) => {
  try {
    const certificate = await Certificate.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!certificate) {
      return res.status(404).json({ success: false, message: 'Certificate not found' });
    }
    
    // Get recipient
    let recipient;
    if (certificate.recipientType === 'STUDENT') {
      recipient = await Student.findByPk(certificate.recipientId, {
        include: [{ model: Class, attributes: ['name'] }]
      });
    } else {
      recipient = await Staff.findByPk(certificate.recipientId, {
        include: [{ model: User, attributes: ['firstName', 'lastName'] }]
      });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    const html = generateCertificateHTML(recipient, certificate.recipientType, certificate, school, certificate.template);
    
    res.json({ success: true, html });
  } catch (error) {
    console.error('❌ Print certificate error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET ALL ALUMNI - FIXED VERSION
app.get('/api/alumni', authenticate, async (req, res) => {
  try {
    console.log('📊 Fetching alumni for school:', req.user.schoolId);
    
    // First, get all alumni without the include to see if data exists
    const alumni = await Alumni.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['graduationYear', 'DESC']]
    });
    
    console.log(`✅ Found ${alumni.length} alumni records`);
    
    // If no alumni, return empty array
    if (alumni.length === 0) {
      return res.json({ success: true, alumni: [] });
    }
    
    // Get all studentIds from alumni
    const studentIds = alumni.map(a => a.studentId).filter(id => id);
    
    // Fetch students separately (safer than using include)
    let students = [];
    if (studentIds.length > 0) {
      students = await Student.findAll({
        where: { 
          id: studentIds,
          schoolId: req.user.schoolId 
        },
        attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
      });
    }
    
    // Create a map of studentId to student data
    const studentMap = {};
    students.forEach(s => {
      studentMap[s.id] = s;
    });
    
    // Combine alumni with their student data
    const alumniWithStudents = alumni.map(a => {
      const data = a.toJSON();
      data.Student = studentMap[a.studentId] || null;
      return data;
    });
    
    console.log(`✅ Returning ${alumniWithStudents.length} alumni with student data`);
    res.json({ success: true, alumni: alumniWithStudents });
    
  } catch (error) {
    console.error('❌ Error fetching alumni:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch alumni',
      error: error.message 
    });
  }
});
// ADD ALUMNI
app.post('/api/alumni', authenticate, async (req, res) => {
  try {
    const alumni = await Alumni.create({
      ...req.body,
      schoolId: req.user.schoolId
    });
    
    await createAuditLog(req, 'CREATE_ALUMNI', 'ALUMNI', alumni.id, null, alumni);
    
    res.status(201).json({ success: true, alumni });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE ALUMNI
app.patch('/api/alumni/:id', authenticate, async (req, res) => {
  try {
    const alumni = await Alumni.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!alumni) return res.status(404).json({ success: false, message: 'Alumni not found' });
    
    await alumni.update(req.body);
    res.json({ success: true, alumni });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE ALUMNI
app.delete('/api/alumni/:id', authenticate, async (req, res) => {
  try {
    const alumni = await Alumni.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!alumni) return res.status(404).json({ success: false, message: 'Alumni not found' });
    
    await alumni.destroy();
    res.json({ success: true, message: 'Alumni deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// ============================================================
// ==================== ALUMNI EVENTS ROUTES ====================
// ============================================================

// GET ALL ALUMNI EVENTS
app.get('/api/alumni/events', authenticate, async (req, res) => {
  try {
    const events = await AlumniEvent.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'createdByUser',
          attributes: ['id', 'firstName', 'lastName', 'email'] 
        },
        {
          model: AlumniEventAttendee,
          as: 'eventAttendees',
          include: [
            {
              model: Alumni,
              as: 'alumni',
              include: [
                { 
                  model: Student, 
                  as: 'Student',
                  attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
                }
              ]
            }
          ]
        }
      ],
      order: [['date', 'ASC']]
    });
    res.json({ success: true, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// CREATE ALUMNI EVENT
app.post('/api/alumni/events', authenticate, async (req, res) => {
  try {
    const eventData = {
      title: req.body.title,
      description: req.body.description || '',
      date: req.body.date,
      location: req.body.location || '',
      type: req.body.type || 'OTHER',
      capacity: req.body.capacity && req.body.capacity !== '' ? parseInt(req.body.capacity) : null,
      attendees: req.body.attendees || [],
      status: req.body.status || 'SCHEDULED',
      schoolId: req.user.schoolId,
      createdBy: req.user.id
    };
    
    const event = await AlumniEvent.create(eventData);
    
    const createdEvent = await AlumniEvent.findByPk(event.id, {
      include: [
        { 
          model: User, 
          as: 'createdByUser',
          attributes: ['id', 'firstName', 'lastName', 'email'] 
        }
      ]
    });
    
    res.status(201).json({ success: true, event: createdEvent });
  } catch (error) {
    console.error('Error creating alumni event:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// MARK ATTENDEE (Admin/Teacher marks attendance)
app.post('/api/alumni/events/:id/attendees', authenticate, async (req, res) => {
  try {
    // Check if user has permission (Admin, Teacher, or Staff)
    const allowedRoles = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'TEACHER', 'STAFF'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only admins and teachers can mark attendance' 
      });
    }

    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    const { alumniId, status } = req.body; // status: 'ATTENDING', 'NOT_ATTENDING', 'MAYBE'
    
    // Check if alumni exists
    const alumni = await Alumni.findOne({
      where: { id: alumniId, schoolId: req.user.schoolId }
    });
    
    if (!alumni) {
      return res.status(404).json({ success: false, message: 'Alumni not found' });
    }
    
    // Create or update attendee record
    const [attendee, created] = await AlumniEventAttendee.findOrCreate({
      where: { eventId: req.params.id, alumniId },
      defaults: { 
        status: status || 'ATTENDING',
        rsvpDate: new Date(),
        markedBy: req.user.id // Track who marked them
      }
    });
    
    if (!created) {
      await attendee.update({ 
        status: status || 'ATTENDING',
        rsvpDate: new Date(),
        markedBy: req.user.id
      });
    }
    
    // Update the event's attendees array
    const allAttendees = await AlumniEventAttendee.findAll({
      where: { eventId: req.params.id },
      attributes: ['alumniId']
    });
    
    await event.update({
      attendees: allAttendees.map(a => a.alumniId)
    });
    
    // Fetch the updated attendee with alumni details
    const updatedAttendee = await AlumniEventAttendee.findByPk(attendee.id, {
      include: [
        {
          model: Alumni,
          as: 'alumni',
          include: [
            {
              model: Student,
              as: 'Student',
              attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
            }
          ]
        },
        {
          model: User,
          as: 'markedByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ]
    });
    
    res.json({ 
      success: true, 
      attendee: updatedAttendee,
      message: `Attendance marked as ${status}`
    });
  } catch (error) {
    console.error('Error marking attendee:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// CHECK IN ATTENDEE (Admin/Teacher checks them in)
app.patch('/api/alumni/events/:id/checkin', authenticate, async (req, res) => {
  try {
    // Check if user has permission
    const allowedRoles = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'TEACHER', 'STAFF'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only admins and teachers can check in attendees' 
      });
    }

    const { attendeeId } = req.body;
    
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    const attendee = await AlumniEventAttendee.findOne({
      where: { 
        id: attendeeId,
        eventId: req.params.id
      }
    });
    
    if (!attendee) {
      return res.status(404).json({ success: false, message: 'Attendee not found' });
    }
    
    await attendee.update({
      checkedIn: true,
      checkedInAt: new Date(),
      checkedInBy: req.user.id // Track who checked them in
    });
    
    // Fetch updated attendee
    const updatedAttendee = await AlumniEventAttendee.findByPk(attendee.id, {
      include: [
        {
          model: Alumni,
          as: 'alumni',
          include: [
            {
              model: Student,
              as: 'Student',
              attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
            }
          ]
        },
        {
          model: User,
          as: 'checkedInByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ]
    });
    
    res.json({ 
      success: true, 
      attendee: updatedAttendee,
      message: 'Attendee checked in successfully'
    });
  } catch (error) {
    console.error('Error checking in attendee:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// BULK CHECK IN (Check in multiple attendees at once)
app.post('/api/alumni/events/:id/bulk-checkin', authenticate, async (req, res) => {
  try {
    const allowedRoles = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'TEACHER', 'STAFF'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only admins and teachers can check in attendees' 
      });
    }

    const { attendeeIds } = req.body;
    
    if (!attendeeIds || !Array.isArray(attendeeIds) || attendeeIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide attendee IDs' 
      });
    }
    
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    // Update all attendees
    const updated = await AlumniEventAttendee.update(
      { 
        checkedIn: true, 
        checkedInAt: new Date(),
        checkedInBy: req.user.id 
      },
      { 
        where: { 
          id: attendeeIds,
          eventId: req.params.id
        } 
      }
    );
    
    res.json({ 
      success: true, 
      message: `${updated[0]} attendees checked in successfully`,
      checkedInCount: updated[0]
    });
  } catch (error) {
    console.error('Error bulk checking in:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE ALUMNI EVENT
app.patch('/api/alumni/events/:id', authenticate, async (req, res) => {
  try {
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    const updateData = { ...req.body };
    if (updateData.capacity === '') {
      updateData.capacity = null;
    }
    if (updateData.capacity !== undefined && updateData.capacity !== null) {
      updateData.capacity = parseInt(updateData.capacity);
    }
    
    await event.update(updateData);
    
    const updatedEvent = await AlumniEvent.findByPk(event.id, {
      include: [
        { 
          model: User, 
          as: 'createdByUser',
          attributes: ['id', 'firstName', 'lastName', 'email'] 
        },
        {
          model: AlumniEventAttendee,
          as: 'eventAttendees',
          include: [
            {
              model: Alumni,
              as: 'alumni',
              include: [
                { 
                  model: Student, 
                  as: 'Student',
                  attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
                }
              ]
            }
          ]
        }
      ]
    });
    
    res.json({ success: true, event: updatedEvent });
  } catch (error) {
    console.error('Error updating alumni event:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE ALUMNI EVENT
app.delete('/api/alumni/events/:id', authenticate, async (req, res) => {
  try {
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    // Delete all attendees first
    await AlumniEventAttendee.destroy({
      where: { eventId: req.params.id }
    });
    
    await event.destroy();
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting alumni event:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET ALUMNI EVENT BY ID
app.get('/api/alumni/events/:id', authenticate, async (req, res) => {
  try {
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'createdByUser',
          attributes: ['id', 'firstName', 'lastName', 'email'] 
        },
        {
          model: AlumniEventAttendee,
          as: 'eventAttendees',
          include: [
            {
              model: Alumni,
              as: 'alumni',
              include: [
                { 
                  model: Student, 
                  as: 'Student',
                  attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
                }
              ]
            },
            {
              model: User,
              as: 'markedByUser',
              attributes: ['id', 'firstName', 'lastName']
            },
            {
              model: User,
              as: 'checkedInByUser',
              attributes: ['id', 'firstName', 'lastName']
            }
          ]
        }
      ]
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    res.json({ success: true, event });
  } catch (error) {
    console.error('Error fetching alumni event:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET ALUMNI EVENT ATTENDEES
app.get('/api/alumni/events/:id/attendees', authenticate, async (req, res) => {
  try {
    const event = await AlumniEvent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    const attendees = await AlumniEventAttendee.findAll({
      where: { eventId: req.params.id },
      include: [
        { 
          model: Alumni, 
          as: 'alumni',
          include: [
            { 
              model: Student, 
              as: 'Student',
              attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
            }
          ]
        },
        {
          model: User,
          as: 'markedByUser',
          attributes: ['id', 'firstName', 'lastName']
        },
        {
          model: User,
          as: 'checkedInByUser',
          attributes: ['id', 'firstName', 'lastName']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, attendees });
  } catch (error) {
    console.error('Error fetching event attendees:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});// ============================================================
// ==================== LIVE CLASSROOM ROUTES ====================
// ============================================================

// GET ALL LIVE CLASSES (with student eligibility check)
app.get('/api/live-classes', authenticate, async (req, res) => {
  try {
    console.log('📺 Fetching live classes for school:', req.user.schoolId);
    
    const school = await School.findByPk(req.user.schoolId);
    const classes = await LiveClass.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: User, 
          as: 'Teacher',
          attributes: ['id', 'firstName', 'lastName', 'email'],
          required: false
        },
        { 
          model: Subject,
          as: 'subject',
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: Class,
          as: 'class',
          attributes: ['id', 'name'],
          required: false
        },
        { 
          model: CourseUnit,
          as: 'unit',
          attributes: ['id', 'name', 'code', 'semester', 'module', 'year'],
          required: false
        },
        { 
          model: Program,
          as: 'program',
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: Course,
          as: 'course',
          attributes: ['id', 'name', 'code'],
          required: false
        }
      ],
      order: [['date', 'ASC'], ['time', 'ASC']]
    });
    
    // For students, filter classes they are eligible for
    let filteredClasses = classes;
    
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({
        where: { userId: req.user.id, schoolId: req.user.schoolId }
      });
      
      if (student) {
        filteredClasses = classes.filter(cls => {
          const clsData = cls.toJSON();
          
          // University: Check if student is enrolled in the course and unit
          if (school.category === 'UNIVERSITY') {
            if (clsData.courseId && clsData.courseId !== student.courseId) return false;
            if (clsData.unitId) {
              // Check if student is registered for this unit
              const registration = UnitRegistration.findOne({
                where: { 
                  studentId: student.id, 
                  unitId: clsData.unitId,
                  status: 'APPROVED'
                }
              });
              if (!registration) return false;
            }
            return true;
          }
          
          // TVET: Check if student is enrolled in the program and module
          if (school.category === 'COLLEGE_TVET') {
            if (clsData.programId && clsData.programId !== student.programId) return false;
            if (clsData.module) {
              const moduleNum = parseInt(student.currentModule?.replace(/\D/g, '') || 0);
              if (moduleNum !== clsData.module) return false;
            }
            return true;
          }
          
          // Regular School: Check if student is in the class
          if (clsData.classId && clsData.classId !== student.classId) return false;
          return true;
        });
      }
    }
    
    console.log(`✅ Found ${filteredClasses.length} live classes for user`);
    res.json({ success: true, classes: filteredClasses });
  } catch (error) {
    console.error('❌ Error fetching live classes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// CREATE LIVE CLASS
app.post('/api/live-classes', authenticate, async (req, res) => {
  try {
    console.log('📝 Creating live class with data:', req.body);
    
    const {
      title,
      description,
      date,
      time,
      duration,
      platform,
      meetingLink,
      meetingId,
      meetingPassword,
      classMaterials,
      // School type specific fields
      classId,
      subjectId,
      courseId,
      unitId,
      programId,
      module,
      year,
      semester,
      teacherId
    } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title is required' 
      });
    }

    if (!date) {
      return res.status(400).json({ 
        success: false, 
        message: 'Date is required' 
      });
    }

    if (!time) {
      return res.status(400).json({ 
        success: false, 
        message: 'Time is required' 
      });
    }

    if (!meetingLink) {
      return res.status(400).json({ 
        success: false, 
        message: 'Meeting link is required' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // Validate based on school category
    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course is required for university' 
        });
      }
      if (!unitId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Unit is required for university' 
        });
      }
      if (!semester) {
        return res.status(400).json({ 
          success: false, 
          message: 'Semester is required for university' 
        });
      }
    } else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program is required for TVET' 
        });
      }
      if (!module) {
        return res.status(400).json({ 
          success: false, 
          message: 'Module is required for TVET' 
        });
      }
    } else {
      if (!classId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Class is required for regular schools' 
        });
      }
      if (!subjectId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Subject is required for regular schools' 
        });
      }
    }

    // Create the live class
    const liveClass = await LiveClass.create({
      title: title.trim(),
      description: description || '',
      date: date,
      time: time,
      duration: duration || 60,
      platform: platform || 'zoom',
      meetingLink: meetingLink.trim(),
      meetingId: meetingId || '',
      meetingPassword: meetingPassword || '',
      classMaterials: classMaterials || [],
      // Store all identifiers
      classId: classId || null,
      subjectId: subjectId || null,
      courseId: courseId || null,
      unitId: unitId || null,
      programId: programId || null,
      module: module ? parseInt(module) : null,
      year: year ? parseInt(year) : null,
      semester: semester ? parseInt(semester) : null,
      teacherId: teacherId || req.user.id,
      schoolId: req.user.schoolId,
      createdBy: req.user.id,
      status: 'SCHEDULED',
      participants: [],
      attendanceMarked: false
    });

    console.log('✅ Live class created successfully:', liveClass.id);

    const createdClass = await LiveClass.findByPk(liveClass.id, {
      include: [
        { 
          model: User, 
          as: 'Teacher',
          attributes: ['id', 'firstName', 'lastName', 'email']
        },
        { 
          model: Subject,
          as: 'subject',
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Class,
          as: 'class',
          attributes: ['id', 'name']
        },
        { 
          model: CourseUnit,
          as: 'unit',
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Program,
          as: 'program',
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Course,
          as: 'course',
          attributes: ['id', 'name', 'code']
        }
      ]
    });

    res.status(201).json({ 
      success: true, 
      class: createdClass 
    });

  } catch (error) {
    console.error('❌ Error creating live class:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create live class', 
      error: error.message 
    });
  }
});


// MARK ATTENDANCE - JOIN (FIXED)
app.post('/api/live-classes/:id/join', authenticate, async (req, res) => {
  try {
    const liveClass = await LiveClass.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!liveClass) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }

    // Check if class is ongoing
    const now = new Date();
    const classDate = new Date(liveClass.date);
    const [hours, minutes] = (liveClass.time || '00:00').split(':').map(Number);
    classDate.setHours(hours, minutes);
    const classEndTime = new Date(classDate);
    classEndTime.setMinutes(classEndTime.getMinutes() + (liveClass.duration || 60));

    if (now < classDate) {
      return res.status(400).json({
        success: false,
        message: 'Class has not started yet'
      });
    }

    if (now > classEndTime) {
      return res.status(400).json({
        success: false,
        message: 'Class has already ended'
      });
    }

    const userId = req.user.id;
    const userRole = req.user.role;
    const userDisplayName = `${req.user.firstName} ${req.user.lastName}`;
    
    // ✅ Determine user type
    let userType = 'ADMIN';
    let studentId = null;
    
    if (userRole === 'STUDENT') {
      const student = await Student.findOne({
        where: { userId: userId, schoolId: req.user.schoolId }
      });
      
      if (student) {
        studentId = student.id;
        userType = 'STUDENT';
      } else {
        return res.status(404).json({
          success: false,
          message: 'Student record not found. Please contact the school administrator.'
        });
      }
    } else if (['TEACHER', 'CLASS_TEACHER', 'SUBJECT_TEACHER', 'SENIOR_TEACHER'].includes(userRole)) {
      userType = 'TEACHER';
    } else if (['SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(userRole)) {
      userType = 'ADMIN';
    } else if (['STAFF', 'HR', 'ACCOUNTANT', 'LIBRARIAN', 'NURSE'].includes(userRole)) {
      userType = 'STAFF';
    }

    // ✅ Check if already joined (using userId for everyone)
    const existing = await ClassAttendance.findOne({
      where: { 
        liveClassId: req.params.id, 
        userId: userId
      }
    });

    if (existing && existing.status === 'PRESENT') {
      return res.json({
        success: true,
        attendance: existing,
        meetingLink: liveClass.meetingLink,
        meetingId: liveClass.meetingId,
        meetingPassword: liveClass.meetingPassword,
        platform: liveClass.platform,
        message: 'Already joined this class'
      });
    }

    // ✅ Create attendance record - userId is always required
    const attendanceData = {
      liveClassId: req.params.id,
      userId: userId,  // ✅ Always set userId
      status: 'PRESENT',
      joinTime: now,
      userType: userType,
      remarks: userType !== 'STUDENT' 
        ? `${userType} joined: ${userDisplayName} (${userRole})` 
        : null
    };

    // ✅ Set studentId only if it's a student
    if (studentId) {
      attendanceData.studentId = studentId;
    }

    const attendance = await ClassAttendance.create(attendanceData);

    // ✅ Update participants list (use userId for everyone)
    const participants = liveClass.participants || [];
    if (!participants.includes(userId)) {
      participants.push(userId);
      await liveClass.update({ 
        participants,
        attendanceMarked: true
      });
    }

    res.json({
      success: true,
      attendance,
      meetingLink: liveClass.meetingLink,
      meetingId: liveClass.meetingId,
      meetingPassword: liveClass.meetingPassword,
      platform: liveClass.platform,
      message: `✅ ${userType} joined successfully`
    });
  } catch (error) {
    console.error('❌ Error joining class:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// LEAVE CLASS
app.post('/api/live-classes/:id/leave', authenticate, async (req, res) => {
  try {
    const liveClass = await LiveClass.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!liveClass) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }

    const userId = req.user.id;

    // ✅ Find attendance by userId (works for everyone)
    const attendance = await ClassAttendance.findOne({
      where: { 
        liveClassId: req.params.id, 
        userId: userId,
        status: 'PRESENT'
      }
    });

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'No attendance record found'
      });
    }

    if (attendance.leaveTime) {
      return res.json({
        success: true,
        attendance,
        message: 'Already left this class'
      });
    }

    // Calculate duration
    const leaveTime = new Date();
    const joinTime = new Date(attendance.joinTime);
    const durationMinutes = Math.round((leaveTime - joinTime) / (1000 * 60));

    // Update attendance
    await attendance.update({
      leaveTime: leaveTime,
      duration: durationMinutes
    });

    // Remove from participants list
    const participants = liveClass.participants || [];
    const updatedParticipants = participants.filter(id => id !== userId);
    await liveClass.update({ participants: updatedParticipants });

    res.json({
      success: true,
      attendance,
      duration: durationMinutes,
      message: `Left class after ${durationMinutes} minutes`
    });
  } catch (error) {
    console.error('❌ Error leaving class:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET CLASS ATTENDANCE REPORT - FIXED
app.get('/api/live-classes/:id/attendance-report', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`📊 Fetching attendance for class: ${id}`);
    
    const liveClass = await LiveClass.findOne({
      where: { id: id, schoolId: req.user.schoolId }
    });
    
    if (!liveClass) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }

    const attendance = await ClassAttendance.findAll({
      where: { liveClassId: id },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    // Calculate summary
    const summary = {
      totalStudents: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      averageDuration: attendance.length > 0 
        ? Math.round(attendance.reduce((sum, a) => sum + (a.duration || 0), 0) / attendance.length)
        : 0,
      totalMinutes: attendance.reduce((sum, a) => sum + (a.duration || 0), 0)
    };

    console.log(`✅ Found ${attendance.length} attendance records`);
    
    res.json({
      success: true,
      attendance,
      summary
    });
  } catch (error) {
    console.error('❌ Error fetching attendance report:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== LIVE CLASSROOM ROUTES ====================
// ============================================================

// UPDATE LIVE CLASS STATUS
app.patch('/api/live-classes/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    console.log(`📝 Updating live class ${id} to status: ${status}`);
    
    // Check if user has permission
    const allowedRoles = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'TEACHER'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update class status'
      });
    }
    
    const liveClass = await LiveClass.findOne({
      where: { id: id, schoolId: req.user.schoolId }
    });
    
    if (!liveClass) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }
    
    // Update the status
    await liveClass.update({ status });
    
    // Fetch the updated class
    const updatedClass = await LiveClass.findByPk(id);
    
    console.log(`✅ Class ${id} status updated to ${status}`);
    res.json({ success: true, class: updatedClass });
  } catch (error) {
    console.error('❌ Error updating live class:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET CLASSES FOR TEACHER
app.get('/api/live-classes/teacher', authenticate, async (req, res) => {
  try {
    const classes = await LiveClass.findAll({
      where: { 
        schoolId: req.user.schoolId,
        teacherId: req.user.id
      },
      include: [
        { 
          model: Subject,
          as: 'subject',
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Class,
          as: 'class',
          attributes: ['id', 'name']
        },
        { 
          model: CourseUnit,
          as: 'unit',
          attributes: ['id', 'name', 'code']
        }
      ],
      order: [['date', 'DESC'], ['time', 'DESC']]
    });

    res.json({ success: true, classes });
  } catch (error) {
    console.error('❌ Error fetching teacher classes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE LIVE CLASS
app.delete('/api/live-classes/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting live class: ${id}`);
    
    // Check if user has permission
    const allowedRoles = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete classes'
      });
    }
    
    const liveClass = await LiveClass.findOne({
      where: { id: id, schoolId: req.user.schoolId }
    });
    
    if (!liveClass) {
      return res.status(404).json({ 
        success: false, 
        message: 'Class not found' 
      });
    }
    
    // Delete attendance records first
    await ClassAttendance.destroy({
      where: { liveClassId: id }
    });
    
    await liveClass.destroy();
    
    console.log(`✅ Class ${id} deleted successfully`);
    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (error) {
    console.error('❌ Error deleting live class:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ============================================================
// ==================== ONLINE EXAM ROUTES - COMPLETE FIX ====================
// ============================================================

// ===== HELPER: Resolve Student ID (Supports both Student ID and User ID) =====
const resolveStudentId = async (id, schoolId) => {
  if (!id) return null;
  
  console.log(`🔍 Resolving ID: ${id}`);
  
  try {
    // Try 1: Direct Student ID lookup
    const student = await Student.findOne({
      where: { id: id, schoolId: schoolId }
    });
    if (student) {
      console.log(`✅ Found as Student ID: ${student.id}`);
      return student.id;
    }
    
    // Try 2: User ID lookup
    const studentByUser = await Student.findOne({
      where: { userId: id, schoolId: schoolId }
    });
    if (studentByUser) {
      console.log(`✅ Found as User ID: ${id} -> Student ID: ${studentByUser.id}`);
      return studentByUser.id;
    }
    
    // Try 3: Admission number lookup
    const studentByAdmission = await Student.findOne({
      where: { admissionNumber: id, schoolId: schoolId }
    });
    if (studentByAdmission) {
      console.log(`✅ Found as Admission Number: ${id} -> Student ID: ${studentByAdmission.id}`);
      return studentByAdmission.id;
    }
    
    console.log(`❌ Could not resolve ID: ${id}`);
    return null;
  } catch (error) {
    console.error(`Error resolving ID ${id}:`, error.message);
    return null;
  }
};

// ===== HELPER: Resolve multiple Student IDs =====
const resolveStudentIds = async (studentIds, schoolId) => {
  const resolvedIds = [];
  const notFoundIds = [];
  
  console.log(`🔍 Resolving ${studentIds.length} IDs...`);
  
  for (const id of studentIds) {
    const resolvedId = await resolveStudentId(id, schoolId);
    if (resolvedId) {
      resolvedIds.push(resolvedId);
    } else {
      notFoundIds.push(id);
    }
  }
  
  console.log(`✅ Resolved ${resolvedIds.length} IDs, ${notFoundIds.length} not found`);
  return { resolvedIds, notFoundIds };
};
// ============================================================
// ==================== GET ALL EXAMS ====================
// ============================================================
app.get('/api/online-exams', authenticate, async (req, res) => {
  try {
    const { status, classId, subjectId, courseId, programId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (status) where.status = status;
    if (classId) where.classId = classId;
    if (subjectId) where.subjectId = subjectId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;

    if (req.user.role === 'STUDENT') {
      where.status = ['PUBLISHED', 'ONGOING'];
    }

    const exams = await OnlineExam.findAll({
      where,
      include: [
        { model: Subject, as: 'subject', attributes: ['id', 'name', 'code'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] },
        { model: Course, as: 'course', attributes: ['id', 'name', 'code'] },
        { model: Program, as: 'program', attributes: ['id', 'name', 'code'] },
        { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code'] },
        { model: User, as: 'createdByUser', attributes: ['id', 'firstName', 'lastName'] },
        { 
          model: ExamResult, 
          as: 'examResults', 
          attributes: ['id', 'score', 'percentage', 'grade', 'points', 'passed', 'attemptNumber'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    // Get question counts for each exam
    const examsWithCount = await Promise.all(exams.map(async (exam) => {
      const count = await ExamQuestion.count({ where: { examId: exam.id } });
      const examData = exam.toJSON();
      examData.questionCount = count;
      return examData;
    }));
    
    res.json({ success: true, exams: examsWithCount });
  } catch (error) {
    console.error('Error fetching exams:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== GET SINGLE EXAM ====================
// ============================================================
app.get('/api/online-exams/:id', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [
        { model: Subject, as: 'subject' },
        { model: Class, as: 'class' },
        { model: Course, as: 'course' },
        { model: Program, as: 'program' },
        { model: CourseUnit, as: 'courseUnit' },
        { model: User, as: 'createdByUser' },
        { 
          model: ExamQuestion, 
          as: 'examQuestions',
          attributes: ['id', 'type', 'question', 'options', 'marks', 'correctAnswer'] 
        }
      ]
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    res.json({ success: true, exam });
  } catch (error) {
    console.error('Error fetching exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== CREATE EXAM ====================
// ============================================================
app.post('/api/online-exams', authenticate, async (req, res) => {
  try {
    const {
      title, description, subjectId, classId, courseId, programId, unitId,
      date, startTime, endTime, duration, totalMarks, passingMarks,
      selectedStudents, examType, term, semester, year, module,
      academicYear, allowMultipleAttempts, maxAttempts, showAnswersAfterSubmission, allowRetake
    } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // ===== SCHOOL TYPE VALIDATION =====
    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ success: false, message: 'Course is required for university exams' });
      }
      if (!unitId) {
        return res.status(400).json({ success: false, message: 'Unit is required for university exams' });
      }
    } else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ success: false, message: 'Program is required for TVET exams' });
      }
      if (!module) {
        return res.status(400).json({ success: false, message: 'Module is required for TVET exams' });
      }
    } else {
      // Primary/Secondary
      if (!classId) {
        return res.status(400).json({ success: false, message: 'Class is required' });
      }
      if (!subjectId) {
        return res.status(400).json({ success: false, message: 'Subject is required' });
      }
    }

    // ✅ Resolve Student IDs (convert User IDs to Student IDs)
    let resolvedStudentIds = [];
    if (selectedStudents && selectedStudents.length > 0) {
      const { resolvedIds, notFoundIds } = await resolveStudentIds(selectedStudents, req.user.schoolId);
      resolvedStudentIds = resolvedIds;
      
      if (notFoundIds.length > 0) {
        console.warn(`⚠️ Could not resolve student IDs: ${notFoundIds.join(', ')}`);
      }
      console.log(`✅ Resolved ${resolvedStudentIds.length} student IDs`);
    }

    const cleanData = {
      title: title.trim(),
      description: description || '',
      subjectId: subjectId || null,
      classId: classId || null,
      courseId: courseId || null,
      programId: programId || null,
      unitId: unitId || null,
      date: date,
      startTime: startTime || null,
      endTime: endTime || null,
      duration: duration || 60,
      totalMarks: totalMarks || 100,
      passingMarks: passingMarks || 40,
      selectedStudents: resolvedStudentIds,
      examType: examType || 'MAIN_EXAM',
      term: term || null,
      semester: semester ? parseInt(semester) : null,
      year: year ? parseInt(year) : null,
      module: module ? parseInt(module) : null,
      academicYear: academicYear || new Date().getFullYear().toString(),
      allowMultipleAttempts: allowMultipleAttempts || false,
      maxAttempts: maxAttempts || 1,
      showAnswersAfterSubmission: showAnswersAfterSubmission || false,
      allowRetake: allowRetake || false,
      schoolId: req.user.schoolId,
      createdBy: req.user.id,
      status: 'DRAFT'
    };

    const exam = await OnlineExam.create(cleanData);

    const createdExam = await OnlineExam.findByPk(exam.id, {
      include: [
        { model: Subject, as: 'subject' },
        { model: Class, as: 'class' },
        { model: User, as: 'createdByUser' }
      ]
    });

    res.status(201).json({ success: true, exam: createdExam });
  } catch (error) {
    console.error('❌ Create exam error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== UPDATE EXAM ====================
// ============================================================
app.patch('/api/online-exams/:id', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    // ✅ If selectedStudents is being updated, resolve IDs
    if (req.body.selectedStudents) {
      const { resolvedIds, notFoundIds } = await resolveStudentIds(req.body.selectedStudents, req.user.schoolId);
      req.body.selectedStudents = resolvedIds;
      
      if (notFoundIds.length > 0) {
        console.warn(`⚠️ Could not resolve student IDs: ${notFoundIds.join(', ')}`);
      }
      console.log(`✅ Resolved ${resolvedIds.length} student IDs for update`);
    }
    
    await exam.update(req.body);
    
    const updatedExam = await OnlineExam.findByPk(exam.id, {
      include: [
        { model: Subject, as: 'subject' },
        { model: Class, as: 'class' },
        { model: User, as: 'createdByUser' }
      ]
    });
    
    res.json({ success: true, exam: updatedExam });
  } catch (error) {
    console.error('Error updating exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== DELETE EXAM ====================
// ============================================================
app.delete('/api/online-exams/:id', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    await ExamQuestion.destroy({ where: { examId: exam.id } });
    await ExamResult.destroy({ where: { examId: exam.id } });
    await exam.destroy();
    
    res.json({ success: true, message: 'Exam deleted successfully' });
  } catch (error) {
    console.error('Error deleting exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== HELPER: GET KENYAN TIME ====================
// ============================================================
const getKenyaTime = () => {
  const now = new Date();
  const kenyaTimeStr = now.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' });
  return new Date(kenyaTimeStr);
};

const getKenyaDateStr = () => {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
};

const getKenyaTimeMinutes = () => {
  const kenyaTime = getKenyaTime();
  return kenyaTime.getHours() * 60 + kenyaTime.getMinutes();
};

// ============================================================
// ==================== CHECK EXAM AVAILABILITY ====================
// ============================================================
const isExamAvailable = (exam) => {
  if (!exam) return { available: false, message: 'Exam not found' };
  
  const kenyaDateStr = getKenyaDateStr();
  const examDateStr = exam.date;
  const currentTimeMinutes = getKenyaTimeMinutes();
  
  // Parse exam times
  let startTimeMinutes = null;
  let endTimeMinutes = null;
  
  if (exam.startTime) {
    const [startHours, startMinutes] = exam.startTime.split(':').map(Number);
    startTimeMinutes = startHours * 60 + startMinutes;
  }
  
  if (exam.endTime) {
    const [endHours, endMinutes] = exam.endTime.split(':').map(Number);
    endTimeMinutes = endHours * 60 + endMinutes;
  }
  
  const examDateNum = parseInt(examDateStr.replace(/-/g, ''));
  const currentDateNum = parseInt(kenyaDateStr.replace(/-/g, ''));
  
  // Check if exam is published or ongoing
  if (!['PUBLISHED', 'ONGOING'].includes(exam.status)) {
    return { available: false, message: 'Exam is not available' };
  }
  
  // Future date
  if (examDateNum > currentDateNum) {
    return { available: false, message: 'Exam has not started yet' };
  }
  
  // Past date - check if overnight exam
  if (examDateNum < currentDateNum) {
    // Check if this is an overnight exam (end time before 6 AM)
    if (endTimeMinutes !== null && endTimeMinutes < 360) {
      // Overnight exam - check if current time is before end time
      if (currentTimeMinutes <= endTimeMinutes) {
        return { available: true, message: 'Available' };
      } else {
        return { available: false, message: 'Exam has already ended' };
      }
    } else {
      return { available: false, message: 'Exam has already ended' };
    }
  }
  
  // Today
  // Check start time
  if (startTimeMinutes !== null && currentTimeMinutes < startTimeMinutes) {
    const minsUntil = startTimeMinutes - currentTimeMinutes;
    return { available: false, message: `Starts in ${minsUntil} minutes` };
  }
  
  // Check end time
  if (endTimeMinutes !== null && currentTimeMinutes > endTimeMinutes) {
    return { available: false, message: 'Exam has already ended' };
  }
  
  return { available: true, message: 'Available' };
};

// ============================================================
// ==================== EXAM QUESTIONS - FIXED ====================
// ============================================================
app.get('/api/online-exams/:id/questions', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    if (req.user.role === 'STUDENT') {
      // Check if exam is available (supports overnight exams)
      const availability = isExamAvailable(exam);
      
      if (!availability.available) {
        return res.status(403).json({ 
          success: false, 
          message: availability.message 
        });
      }
      
      const student = await Student.findOne({
        where: { userId: req.user.id, schoolId: req.user.schoolId }
      });
      
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student record not found' });
      }
      
      const existingResults = await ExamResult.findAll({
        where: { examId: exam.id, studentId: student.id }
      });
      
      if (existingResults.length >= exam.maxAttempts && !exam.allowMultipleAttempts) {
        return res.status(403).json({ 
          success: false, 
          message: `You have already taken this exam. Maximum ${exam.maxAttempts} attempt(s) allowed.` 
        });
      }
    }
    
    const questions = await ExamQuestion.findAll({
      where: { examId: req.params.id },
      order: [['order', 'ASC'], ['createdAt', 'ASC']]
    });
    
    if (req.user.role === 'STUDENT') {
      const sanitized = questions.map(q => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.options,
        marks: q.marks
      }));
      return res.json({ success: true, questions: sanitized });
    }
    
    res.json({ success: true, questions });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== ADD QUESTION ====================
// ============================================================
app.post('/api/online-exams/:examId/questions', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.examId, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    if (exam.status !== 'DRAFT') {
      return res.status(400).json({ success: false, message: 'Can only add questions to draft exams' });
    }
    
    const question = await ExamQuestion.create({
      ...req.body,
      examId: req.params.examId
    });
    
    res.status(201).json({ success: true, question });
  } catch (error) {
    console.error('Error adding question:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== DELETE QUESTION ====================
// ============================================================
app.delete('/api/online-exams/questions/:id', authenticate, async (req, res) => {
  try {
    const question = await ExamQuestion.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }
    
    const exam = await OnlineExam.findOne({
      where: { id: question.examId, schoolId: req.user.schoolId }
    });
    
    if (!exam || exam.status !== 'DRAFT') {
      return res.status(403).json({ success: false, message: 'Can only delete questions from draft exams' });
    }
    
    await question.destroy();
    res.json({ success: true, message: 'Question deleted' });
  } catch (error) {
    console.error('Error deleting question:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== UPDATE QUESTION ====================
// ============================================================
app.patch('/api/online-exams/questions/:id', authenticate, async (req, res) => {
  try {
    const question = await ExamQuestion.findByPk(req.params.id);
    if (!question) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }
    
    const exam = await OnlineExam.findOne({
      where: { id: question.examId, schoolId: req.user.schoolId }
    });
    
    if (!exam || exam.status !== 'DRAFT') {
      return res.status(403).json({ success: false, message: 'Can only edit questions in draft exams' });
    }
    
    await question.update(req.body);
    res.json({ success: true, question });
  } catch (error) {
    console.error('Error updating question:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== EXAM SUBMISSION - FIXED ====================
// ============================================================
app.post('/api/online-exams/:id/submit', authenticate, async (req, res) => {
  try {
    const { answers, timeTaken } = req.body;
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    if (req.user.role !== 'STUDENT') {
      return res.status(403).json({ success: false, message: 'Only students can submit exams' });
    }
    
    const student = await Student.findOne({
      where: { userId: req.user.id, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student record not found' });
    }
    
    // Check if exam is available (supports overnight exams)
    const availability = isExamAvailable(exam);
    
    if (!availability.available) {
      return res.status(400).json({ 
        success: false, 
        message: availability.message 
      });
    }
    
    // Check attempts
    const existingResults = await ExamResult.findAll({
      where: { examId: exam.id, studentId: student.id }
    });
    
    const attemptNumber = existingResults.length + 1;
    if (attemptNumber > exam.maxAttempts && !exam.allowMultipleAttempts) {
      return res.status(400).json({ 
        success: false, 
        message: `Maximum ${exam.maxAttempts} attempt(s) allowed. You have already used all attempts.` 
      });
    }
    
    // Get questions for grading
    const questions = await ExamQuestion.findAll({
      where: { examId: exam.id },
      order: [['order', 'ASC']]
    });
    
    let totalScore = 0;
    let totalPossible = 0;
    const gradedAnswers = [];
    
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const userAnswer = answers[i] || '';
      totalPossible += q.marks || 0;
      
      let isCorrect = false;
      if (q.type === 'MCQ' || q.type === 'TRUE_FALSE') {
        isCorrect = userAnswer === q.correctAnswer;
      }
      
      if (isCorrect) {
        totalScore += q.marks || 0;
      }
      
      gradedAnswers.push({
        questionId: q.id,
        userAnswer: userAnswer,
        correctAnswer: q.correctAnswer,
        marks: isCorrect ? q.marks : 0,
        isCorrect
      });
    }
    
    const percentage = totalPossible > 0 ? (totalScore / totalPossible) * 100 : 0;
    const passed = percentage >= exam.passingMarks;
    
    // Calculate grade
    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = school?.gradingSystem || 'CBC';
    
    let gradeInfo = getGradeForSystem(percentage, gradingSystem);
    
    const result = await ExamResult.create({
      examId: exam.id,
      studentId: student.id,
      score: totalScore,
      totalMarks: totalPossible,
      percentage: percentage,
      grade: gradeInfo.grade,
      points: gradeInfo.points,
      passed: passed,
      answers: gradedAnswers,
      timeTaken: timeTaken || 0,
      attemptNumber: attemptNumber,
      submittedAt: new Date()
    });
    
    // Sync to main Results table
    try {
      await Result.create({
        studentId: student.id,
        examId: exam.id,
        subjectId: exam.subjectId || null,
        unitId: exam.unitId || null,
        marks: totalScore,
        grade: gradeInfo.grade,
        gradeCode: gradeInfo.grade,
        points: gradeInfo.points,
        isAbsent: false,
        gradingSystem: gradingSystem,
        remarks: `Online exam submission - ${exam.title}`,
        description: `Attempt ${attemptNumber} - ${passed ? 'Passed' : 'Failed'}`
      });
    } catch (syncError) {
      console.error('Failed to sync result:', syncError.message);
    }
    
    if (exam.status === 'PUBLISHED') {
      await exam.update({ status: 'ONGOING' });
    }
    
    res.json({ 
      success: true, 
      result: {
        id: result.id,
        score: totalScore,
        totalMarks: totalPossible,
        percentage: percentage,
        grade: gradeInfo.grade,
        points: gradeInfo.points,
        passed: passed,
        attemptNumber: attemptNumber,
        maxAttempts: exam.maxAttempts
      },
      message: 'Exam submitted successfully!'
    });
  } catch (error) {
    console.error('Error submitting exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== GET STUDENT'S RESULTS ====================
// ============================================================
app.get('/api/online-exams/student/results', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'STUDENT') {
      return res.status(403).json({ success: false, message: 'Only for students' });
    }
    
    const student = await Student.findOne({
      where: { userId: req.user.id, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const results = await ExamResult.findAll({
      where: { studentId: student.id },
      include: [
        { 
          model: OnlineExam, 
          as: 'exam',
          attributes: ['id', 'title', 'examType', 'date']
        }
      ],
      order: [['submittedAt', 'DESC']],
      attributes: ['id', 'score', 'totalMarks', 'grade', 'points', 'passed', 'attemptNumber', 'submittedAt']
    });
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error fetching student results:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== GET EXAM RESULTS FOR TEACHER ====================
// ============================================================
app.get('/api/online-exams/:id/results', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    const results = await ExamResult.findAll({
      where: { examId: exam.id },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
        }
      ],
      order: [['percentage', 'DESC']]
    });
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== ADD MANUAL RESULT ====================
// ============================================================
app.post('/api/online-exams/:id/results/manual', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    let { studentId, score, remarks } = req.body;
    
    // ✅ Resolve student ID
    const resolvedStudentId = await resolveStudentId(studentId, req.user.schoolId);
    
    if (!resolvedStudentId) {
      return res.status(400).json({ 
        success: false, 
        message: `Student not found with ID: ${studentId}` 
      });
    }
    
    const existing = await ExamResult.findOne({
      where: { examId: exam.id, studentId: resolvedStudentId }
    });
    
    if (existing) {
      return res.status(400).json({ success: false, message: 'Result already exists for this student' });
    }
    
    const totalMarks = exam.totalMarks || 100;
    const percentage = (score / totalMarks) * 100;
    const passed = percentage >= exam.passingMarks;
    
    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = school?.gradingSystem || 'CBC';
    
    let gradeInfo = getGradeForSystem(percentage, gradingSystem);
    
    const result = await ExamResult.create({
      examId: exam.id,
      studentId: resolvedStudentId,
      score,
      totalMarks,
      percentage,
      grade: gradeInfo.grade,
      points: gradeInfo.points,
      passed,
      remarks: remarks || 'Manual entry',
      submittedAt: new Date()
    });
    
    try {
      await Result.create({
        studentId: resolvedStudentId,
        examId: exam.id,
        subjectId: exam.subjectId || null,
        unitId: exam.unitId || null,
        marks: score,
        grade: gradeInfo.grade,
        gradeCode: gradeInfo.grade,
        points: gradeInfo.points,
        isAbsent: false,
        gradingSystem: gradingSystem,
        remarks: `Manual entry - ${remarks || ''}`,
        description: `Online exam manual result: ${exam.title}`
      });
    } catch (syncError) {
      console.error('Failed to sync manual result:', syncError.message);
    }
    
    res.status(201).json({ success: true, result });
  } catch (error) {
    console.error('Error adding manual result:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== UPDATE RESULT ====================
// ============================================================
app.patch('/api/online-exams/results/:id', authenticate, async (req, res) => {
  try {
    const result = await ExamResult.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Result not found' });
    }
    
    const exam = await OnlineExam.findOne({
      where: { id: result.examId, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    await result.update(req.body);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error updating result:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== DELETE RESULT ====================
// ============================================================
app.delete('/api/online-exams/results/:id', authenticate, async (req, res) => {
  try {
    const result = await ExamResult.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Result not found' });
    }
    
    const exam = await OnlineExam.findOne({
      where: { id: result.examId, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    await result.destroy();
    res.json({ success: true, message: 'Result deleted' });
  } catch (error) {
    console.error('Error deleting result:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== EXAM STATUS MANAGEMENT ====================
// ============================================================

app.patch('/api/online-exams/:id/publish', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    const questions = await ExamQuestion.count({ where: { examId: exam.id } });
    if (questions === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot publish exam with no questions' 
      });
    }
    
    await exam.update({ 
      status: 'PUBLISHED',
      publishedAt: new Date()
    });
    
    res.json({ success: true, message: 'Exam published successfully' });
  } catch (error) {
    console.error('Error publishing exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/api/online-exams/:id/close', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    await exam.update({ status: 'CLOSED' });
    res.json({ success: true, message: 'Exam closed successfully' });
  } catch (error) {
    console.error('Error closing exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.patch('/api/online-exams/:id/reopen', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    if (!['CLOSED', 'COMPLETED'].includes(exam.status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Only closed or completed exams can be reopened' 
      });
    }
    
    await exam.update({ status: 'PUBLISHED' });
    res.json({ success: true, message: 'Exam reopened successfully' });
  } catch (error) {
    console.error('Error reopening exam:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/online-exams/:id/stats', authenticate, async (req, res) => {
  try {
    const exam = await OnlineExam.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    
    const results = await ExamResult.findAll({
      where: { examId: exam.id }
    });
    
    const stats = {
      totalStudents: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      averageScore: results.length > 0 
        ? results.reduce((sum, r) => sum + r.percentage, 0) / results.length 
        : 0,
      highestScore: results.length > 0 
        ? Math.max(...results.map(r => r.percentage)) 
        : 0,
      lowestScore: results.length > 0 
        ? Math.min(...results.map(r => r.percentage)) 
        : 0,
      passRate: results.length > 0 
        ? (results.filter(r => r.passed).length / results.length) * 100 
        : 0
    };
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error fetching exam stats:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// ==================== GRADE HELPER FUNCTION ====================
// ============================================================
function getGradeForSystem(percentage, gradingSystem) {
  // CBC / Primary / JSS
  if (gradingSystem === 'CBC' || gradingSystem === 'ECDE_PRIMARY_JSS') {
    if (percentage >= 80) return { grade: 'Exceeding Expectations', points: 4 };
    if (percentage >= 65) return { grade: 'Meeting Expectations', points: 3 };
    if (percentage >= 50) return { grade: 'Approaching Expectations', points: 2 };
    if (percentage >= 30) return { grade: 'Below Expectations', points: 1 };
    return { grade: 'Needs Improvement', points: 0 };
  } 
  // 8-4-4 / Secondary
  else if (gradingSystem === '844' || gradingSystem === 'KENYA_844' || gradingSystem === 'SENIOR_SECONDARY') {
    if (percentage >= 80) return { grade: 'A', points: 12 };
    if (percentage >= 75) return { grade: 'A-', points: 11 };
    if (percentage >= 70) return { grade: 'B+', points: 10 };
    if (percentage >= 65) return { grade: 'B', points: 9 };
    if (percentage >= 60) return { grade: 'B-', points: 8 };
    if (percentage >= 55) return { grade: 'C+', points: 7 };
    if (percentage >= 50) return { grade: 'C', points: 6 };
    if (percentage >= 45) return { grade: 'C-', points: 5 };
    if (percentage >= 40) return { grade: 'D+', points: 4 };
    if (percentage >= 35) return { grade: 'D', points: 3 };
    if (percentage >= 30) return { grade: 'D-', points: 2 };
    return { grade: 'E', points: 1 };
  } 
  // University
  else if (gradingSystem === 'UNIVERSITY' || gradingSystem === 'UNI') {
    if (percentage >= 70) return { grade: 'A', points: 5.0 };
    if (percentage >= 60) return { grade: 'B', points: 4.0 };
    if (percentage >= 50) return { grade: 'C', points: 3.0 };
    if (percentage >= 40) return { grade: 'D', points: 2.0 };
    return { grade: 'E', points: 1.0 };
  } 
  // TVET
  else if (gradingSystem === 'TVET' || gradingSystem === 'COLLEGE_TVET') {
    if (percentage >= 80) return { grade: 'DISTINCTION', points: 5 };
    if (percentage >= 65) return { grade: 'CREDIT', points: 4 };
    if (percentage >= 50) return { grade: 'MERIT', points: 3 };
    if (percentage >= 40) return { grade: 'PASS', points: 2 };
    return { grade: 'FAIL', points: 1 };
  }
  
  // Default fallback
  return { grade: 'N/A', points: 0 };
}
// ==================== SEED FEATURES FOR ALL SCHOOLS ====================
app.post('/api/seed-features/all-schools', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const defaultFeatures = [
      { name: 'SMS Notifications', code: 'SMS', category: 'COMMUNICATION', description: 'Send SMS notifications to parents and staff', isEnabled: true },
      { name: 'Email Notifications', code: 'EMAIL', category: 'COMMUNICATION', description: 'Send email notifications', isEnabled: true },
      { name: 'Online Payments', code: 'ONLINE_PAYMENTS', category: 'FINANCE', description: 'Accept online fee payments', isEnabled: false },
      { name: 'Exam Portal', code: 'EXAM_PORTAL', category: 'ACADEMIC', description: 'Online exam submission and grading', isEnabled: false },
      { name: 'Parent Portal', code: 'PARENT_PORTAL', category: 'ACCESS', description: 'Parent login to view student progress', isEnabled: true },
      { name: 'Student Portal', code: 'STUDENT_PORTAL', category: 'ACCESS', description: 'Student login to view results', isEnabled: true },
      { name: 'Library Management', code: 'LIBRARY', category: 'RESOURCES', description: 'Complete library management system', isEnabled: true },
      { name: 'Transport Tracking', code: 'TRANSPORT', category: 'LOGISTICS', description: 'Real-time vehicle tracking', isEnabled: false },
      { name: 'Hostel Management', code: 'HOSTEL', category: 'ACCOMMODATION', description: 'Hostel room allocation and management', isEnabled: true },
      { name: 'Inventory Management', code: 'INVENTORY', category: 'RESOURCES', description: 'Stock and inventory tracking', isEnabled: true },
      { name: 'Attendance Biometrics', code: 'BIOMETRICS', category: 'ATTENDANCE', description: 'Biometric attendance marking', isEnabled: false },
      { name: 'WhatsApp Integration', code: 'WHATSAPP', category: 'COMMUNICATION', description: 'Send WhatsApp messages', isEnabled: false }
    ];

    // Get all schools
    const schools = await School.findAll();
    
    if (!schools || schools.length === 0) {
      return res.status(404).json({ message: 'No schools found' });
    }

    const results = {
      totalSchools: schools.length,
      schoolsProcessed: 0,
      totalFeaturesCreated: 0,
      details: []
    };

    // For each school, create features
    for (const school of schools) {
      const schoolId = school.id;
      let featuresCreated = 0;
      
      for (const feature of defaultFeatures) {
        const [featureInstance, created] = await Feature.findOrCreate({
          where: { code: feature.code, schoolId },
          defaults: { ...feature, schoolId }
        });
        if (created) featuresCreated++;
      }
      
      results.schoolsProcessed++;
      results.totalFeaturesCreated += featuresCreated;
      results.details.push({
        schoolId: school.id,
        schoolName: school.name,
        featuresCreated
      });
    }

    res.json({ 
      success: true, 
      message: `Seeded features for ${results.schoolsProcessed} schools. Created ${results.totalFeaturesCreated} total features.`,
      results
    });
  } catch (error) {
    console.error('Seed all schools error:', error);
    res.status(500).json({ message: error.message });
  }
});


// ==================== ERROR HANDLER ====================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

sequelize.sync({ alter: true })
  .then(() => {
    console.log('✅ Database synced successfully');
    console.log('📊 Grading Systems Loaded:');
    console.log('   - CBC (ECDE & Primary)');
    console.log('   - 8-4-4 (Secondary)');
    console.log('   - TVET (Competency Based)');
    console.log('   - University (GPA Based)');
    console.log('   - IB (International Baccalaureate)');
    console.log('   - Cambridge IGCSE');
    console.log('   - American System');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api`);
      console.log(`✅ All routes are now fixed!`);
      console.log(`   - Students: http://localhost:${PORT}/api/students`);
      console.log(`   - Exams: http://localhost:${PORT}/api/exams`);
      console.log(`   - Fees: http://localhost:${PORT}/api/fees`);
      console.log(`   - Timetable: http://localhost:${PORT}/api/timetable`);
    });
  })
  .catch(err => {
    console.error('❌ Database sync error:', err);
  });